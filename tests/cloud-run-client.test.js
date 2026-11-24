const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { runInNewContext } = require('node:vm')

const target = { env: 'test-bookings', service: 'store' }
const healthy = {
  ok: true, service: 'shh-booking', storage: 'mysql',
  trial: true, auth: 'wechat', environment: 'wechat-test', wechatIdentity: true,
}
const ok = data => ({ statusCode: 200, data })
const failure = (statusCode, code, error) => ({ statusCode, data: { code, error } })
const token = request => request.header.Authorization
const paths = requests => requests.map(request => request.path)

function cloudClient(version, respond) {
  const requests = []
  const navigation = []
  let initializations = 0
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: version } }),
    cloud: {
      async init(options) {
        assert.equal(options.env, target.env)
        initializations++
      },
      callContainer({ success, config, ...request }) {
        assert.equal(initializations, 1)
        assert.equal(config.env, target.env)
        assert.equal(request.header['X-WX-SERVICE'], target.service)
        requests.push(request)
        success(respond(request))
      },
    },
    switchTab({ url }) { navigation.push(url) },
    navigateTo({ url }) { navigation.push(url) },
    reLaunch({ url, complete }) { navigation.push(url); complete() },
    showToast() {},
  }
  const apiPath = require.resolve('../miniprogram/lib/api')
  const fromApi = createRequire(apiPath)
  const module = { exports: {} }
  runInNewContext(readFileSync(apiPath, 'utf8'), {
    module, wx,
    require(name) { return name === '../config' ? { cloudRun: target } : fromApi(name) },
  })
  return { api: module.exports, requests, navigation, wx }
}

function pageFor(name, { api, wx }) {
  const filename = require.resolve('../miniprogram/pages/' + name + '/index')
  const fromPage = createRequire(filename)
  let page
  runInNewContext(readFileSync(filename, 'utf8'), {
    wx, Page(definition) { page = definition },
    require(name) { return name.endsWith('/api') ? api : fromPage(name) },
  })
  page.setData = changes => Object.assign(page.data, changes)
  return page
}

test('只在开发版或体验版且验证独立测试门店及微信身份后登记', async () => {
  for (const version of ['release', undefined]) {
    const { api, requests } = cloudClient(version, () => assert.fail('不支持的版本发出了云请求'))
    await assert.rejects(api.call('bootstrap'), { code: 'CONFIG', message: /体验版/ })
    assert.equal(requests.length, 0)
  }

  let health = '<html>欢迎使用微信云托管</html>'
  const { api, requests } = cloudClient('trial', request => {
    switch (request.path) {
      case '/health': return ok(health)
      case '/auth/wechat':
        assert.deepEqual(Object.keys(request.data), [])
        assert.equal(token(request), undefined)
        return ok({ token: 'first-wechat-session' })
      case '/api/bootstrap':
        assert.equal(token(request), 'Bearer first-wechat-session')
        return ok({ me: { role: 'pending' } })
      default: assert.fail('意外请求 ' + request.path)
    }
  })
  await assert.rejects(api.call('bootstrap'), { code: 'CONFIG' })
  health = { ...healthy, environment: 'production' }
  await assert.rejects(api.call('bootstrap'), { code: 'CONFIG' })
  health = { ...healthy, wechatIdentity: false }
  await assert.rejects(api.call('bootstrap'), { code: 'UNAUTHORIZED', message: /微信身份/ })
  assert.deepEqual(paths(requests), ['/health', '/health', '/health'])

  health = healthy
  assert.equal((await api.call('bootstrap')).me.role, 'pending')
  assert.deepEqual(paths(requests).slice(3), ['/health', '/auth/wechat', '/api/bootstrap'])
})

test('多个操作共用微信会话，过期后重新登记一次并重试', async () => {
  let issued = 0
  let invalidated = false
  const { api, requests } = cloudClient('develop', request => {
    if (request.path === '/health') return ok(healthy)
    if (request.path === '/auth/wechat') return ok({ token: 'session-' + ++issued })
    if (invalidated && token(request) === 'Bearer session-1') {
      return failure(401, 'UNAUTHORIZED', '会话已失效')
    }
    assert.equal(token(request), 'Bearer session-' + issued)
    return ok({ me: { role: 'manager' } })
  })

  await Promise.all([api.call('bootstrap'), api.call('board')])
  assert.equal(issued, 1)
  invalidated = true
  await Promise.all([api.call('bootstrap'), api.call('board')])
  assert.equal(issued, 2)
  assert.equal(paths(requests).filter(path => path === '/health').length, 1)
  assert.equal(paths(requests).filter(path => path === '/api/board').length, 3)
})

test('仅凭宾客邀请凭证读取详情，不发起员工登记', async () => {
  const { api, requests } = cloudClient('trial', request => {
    if (request.path === '/health') return ok(healthy)
    assert.equal(request.path, '/invite/guest%20%26%20family')
    assert.equal(request.method, 'GET')
    assert.equal(token(request), undefined)
    return ok({ guests: 3 })
  })
  assert.equal((await api.readInvite('guest & family')).guests, 3)
  assert.deepEqual(paths(requests), ['/health', '/invite/guest%20%26%20family'])
})

test('待分配页登记姓名，首绑口令错误保留原会话，绑定成功后更换会话', async () => {
  let me = { id: 'wx_9876543210abcdef', name: '', role: 'pending', nameBound: false }
  let current = 'pending-token'
  const client = cloudClient('trial', request => {
    switch (request.path) {
      case '/health': return ok(healthy)
      case '/auth/wechat': return ok({ token: current, me })
      case '/api/bootstrap':
        assert.equal(token(request), 'Bearer ' + current)
        return ok({ me, canBindAdmin: me.role === 'pending', staff: [], tables: [] })
      case '/api/bindStaffName':
        assert.equal(token(request), 'Bearer ' + current)
        me = { ...me, name: request.data.name, nameBound: true }
        return ok(me)
      case '/auth/wechat/bind-admin':
        assert.equal(token(request), 'Bearer ' + current)
        if (request.data.password !== 'test-management-secret') return failure(401, 'AUTH_FAILED', '管理口令不正确')
        me = { ...me, id: 'manager', role: 'admin' }
        current = 'admin-token'
        return ok({ token: current, me })
      default: assert.fail('意外请求 ' + request.path)
    }
  })
  const page = pageFor('access', client)
  await page.onShow()
  assert.equal(page.data.code, '10ABCDEF')
  assert.equal(page.data.canBindAdmin, true)
  assert.equal(page.data.error, '')
  assert.deepEqual(client.navigation, [])

  page.setData({ name: ' 陈青 ' })
  await page.saveName()
  assert.equal(page.data.me.name, '陈青')
  assert.equal(page.data.me.nameBound, true)

  page.toggleAdmin()
  page.setData({ password: 'wrong-test-secret' })
  await page.bindAdmin()
  assert.match(page.data.error, /管理口令/)
  assert.equal(page.data.password, '')
  assert.equal(paths(client.requests).filter(path => path === '/auth/wechat').length, 1)
  assert.equal(paths(client.requests).filter(path => path.endsWith('bind-admin')).length, 1)

  page.setData({ password: 'test-management-secret' })
  await page.bindAdmin()
  assert.equal(page.data.canBindAdmin, false)
  assert.equal(page.data.password, '')
  assert.deepEqual(client.navigation, ['/pages/account/index'])
  assert.equal((await client.api.call('bootstrap')).me.role, 'admin')
})

test('管理员可分配营销和店长职位，员工刷新后进入工作台，权限撤回时返回等待页', async () => {
  const admin = { id: 'manager', name: '张明', nameBound: true, role: 'admin' }
  let staff = { id: 'wx_0123456789abcdef', name: '陈青', nameBound: true, role: 'pending' }
  const store = { name: '珊瑚海' }
  const adminClient = cloudClient('trial', request => {
    switch (request.path) {
      case '/health': return ok(healthy)
      case '/auth/wechat': return ok({ token: 'admin-token', me: admin })
      case '/api/bootstrap': return ok({ me: admin, store })
      case '/api/staffRoles': return ok([admin, staff])
      case '/api/setStaffRole':
        assert.equal(token(request), 'Bearer admin-token')
        assert.equal(request.data.expectedRole, staff.role)
        assert.equal(request.data.id, staff.id)
        staff = { ...staff, role: request.data.role }
        return ok(staff)
      default: assert.fail('意外请求 ' + request.path)
    }
  })
  const staffClient = cloudClient('trial', request => {
    switch (request.path) {
      case '/health': return ok(healthy)
      case '/auth/wechat': return ok({ token: 'staff-token', me: staff })
      case '/api/bootstrap': return ok(staff.role === 'pending'
        ? { me: staff, canBindAdmin: false, staff: [], tables: [] }
        : { me: staff, store })
      case '/api/order': return failure(403, 'ACCESS_PENDING', '请等待管理员分配员工职位')
      default: assert.fail('意外请求 ' + request.path)
    }
  })
  const waiting = pageFor('access', staffClient)
  await waiting.onShow()
  assert.equal(waiting.data.canBindAdmin, false)
  assert.deepEqual(staffClient.navigation, [])

  const adminAccount = pageFor('account', adminClient)
  await adminAccount.onShow()
  adminAccount.openStaffRoles()
  assert.deepEqual(adminClient.navigation, ['/pages/staff/index'])

  const roster = pageFor('staff', adminClient)
  await roster.onShow()
  assert.equal(roster.data.staff[0].role, 'pending')
  assert.equal(roster.data.staff[0].code, waiting.data.code)
  assert.deepEqual(Array.from(roster.data.roleOptions, option => option.role), ['sales', 'finance', 'manager', 'pending'])

  const target = { currentTarget: { dataset: { id: staff.id } } }
  const assign = async role => {
    roster.editRole(target)
    const value = roster.data.roleOptions.findIndex(option => option.role === role)
    roster.chooseRole({ ...target, detail: { value } })
    await roster.saveRole(target)
  }
  await assign('sales')
  assert.equal(staff.role, 'sales')
  await waiting.refresh()
  assert.deepEqual(staffClient.navigation, ['/pages/index/index'])

  await assign('manager')
  const managerAccount = pageFor('account', staffClient)
  await managerAccount.onShow()
  assert.equal(managerAccount.data.role, '店长')
  managerAccount.openStaffRoles()
  assert.deepEqual(staffClient.navigation, ['/pages/index/index'])

  await assign('pending')
  await assert.rejects(staffClient.api.call('order', { id: 'order-1' }), { code: 'ACCESS_PENDING' })
  assert.deepEqual(staffClient.navigation, ['/pages/index/index', '/pages/access/index'])
})

test('管理员更新员工资料时显示校验结果，并在资料冲突后刷新员工列表', async () => {
  const admin = { id: 'manager', name: '张明', nameBound: true, role: 'admin' }
  let staff = { id: 'wx_0123456789abcdef', name: '陈青', nameBound: true, role: 'sales', servicePhone: '13800001234' }
  const client = cloudClient('trial', request => {
    switch (request.path) {
      case '/health': return ok(healthy)
      case '/auth/wechat': return ok({ token: 'admin-token', me: admin })
      case '/api/bootstrap': return ok({ me: admin })
      case '/api/staffRoles': return ok([admin, staff])
      case '/api/setStaffProfile': {
        assert.equal(token(request), 'Bearer admin-token')
        const { id, name, servicePhone, expectedName, expectedServicePhone } = request.data
        assert.equal(id, staff.id)
        assert.equal(request.data.role, undefined)
        if (expectedName !== staff.name || expectedServicePhone !== (staff.servicePhone || '')) {
          return failure(409, 'VERSION_CONFLICT', '员工资料已更新，请核对后重新编辑。')
        }
        if (servicePhone && !/^1\d{10}$/.test(servicePhone)) return failure(400, 'VALIDATION', '服务手机号格式不正确')
        staff = { ...staff, name, servicePhone: servicePhone || undefined }
        return ok(staff)
      }
      default: assert.fail('意外请求 ' + request.path)
    }
  })
  const roster = pageFor('staff', client)
  await roster.onShow()
  const target = { currentTarget: { dataset: { id: staff.id } } }
  const input = (field, value) => roster.editProfileField({
    currentTarget: { dataset: { id: staff.id, field } }, detail: { value },
  })
  const member = () => roster.data.staff.find(person => person.id === staff.id)
  roster.editProfile(target)
  assert.equal(roster.data.editPhone, '13800001234')
  input('editName', ' 陈青云 ')
  input('editPhone', '123')
  await roster.saveProfile(target)
  assert.match(roster.data.editError, /手机号格式/)
  assert.equal(roster.data.editName, ' 陈青云 ')
  assert.equal(member().name, '陈青')

  input('editPhone', '')
  await roster.saveProfile(target)
  assert.equal(roster.data.editId, '')
  assert.equal(member().name, '陈青云')
  assert.equal(member().servicePhone, undefined)
  assert.equal(member().role, 'sales')

  roster.editProfile(target)
  input('editPhone', '13900005678')
  staff = { ...staff, servicePhone: '13900009876' }
  await roster.saveProfile(target)
  assert.equal(roster.data.editId, '')
  assert.match(roster.data.notice, /资料已更新/)
  assert.equal(member().servicePhone, '13900009876')
})
