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
const privateDetails = 'openid=wx-private-user phone=13900009999 bearer=test-private-session'
const privateValues = /wx-private-user|13900009999|test-private-session/
const timedOut = { errCode: -102002, errMsg: 'callContainer:fail request timeout ' + privateDetails }

async function advanceCloud(t, ms) {
  t.mock.timers.tick(ms)
  await new Promise(setImmediate)
}

async function waitForAccess(t, page) {
  for (let elapsed = 0; page.data.checking && elapsed < 60000; elapsed += 1000) {
    await advanceCloud(t, 1000)
  }
  assert.equal(page.data.checking, false)
}

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
      callContainer({ success, fail, config, ...request }) {
        assert.equal(initializations, 1)
        assert.equal(config.env, target.env)
        assert.equal(request.header['X-WX-SERVICE'], target.service)
        requests.push(request)
        const response = respond(request, { success, fail })
        if (typeof response?.then === 'function') return response
        if (response !== undefined) success(response)
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
    module, wx, Date, setTimeout,
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

test('先初始化云托管，再调用初始化时可用的容器接口', async () => {
  const { api, wx, requests } = cloudClient('trial', request => {
    if (request.path === '/health') return ok(healthy)
    if (request.path === '/auth/wechat') return ok({ token: 'wechat-session' })
    assert.equal(request.path, '/api/bootstrap')
    return ok({ me: { role: 'manager' } })
  })
  const { init, callContainer } = wx.cloud
  delete wx.cloud.callContainer
  let initializationFailed = true
  wx.cloud.init = options => {
    if (initializationFailed) throw Object.assign(new Error(privateDetails), { code: -601027 })
    return init(options).then(() => { wx.cloud.callContainer = callContainer })
  }

  await assert.rejects(api.call('bootstrap'), error => {
    assert.match(error.message, /微信云托管初始化.*微信错误码 -601027/)
    assert.doesNotMatch(error.message, privateValues)
    return true
  })
  assert.deepEqual(requests, [])

  initializationFailed = false
  assert.equal((await api.call('bootstrap')).me.role, 'manager')
  assert.deepEqual(paths(requests), ['/health', '/auth/wechat', '/api/bootstrap'])
})

test('首次进入时等候门店冷启动，并发请求共用健康检查和微信登录', async t => {
  const scenarios = {
    '网关立即返回 HTTP 503': () => failure(503, 'UNAVAILABLE', privateDetails),
    '微信请求达到超时上限': (request, fail) => { setTimeout(() => fail(timedOut), request.timeout) },
  }
  for (const [name, failWhenCold] of Object.entries(scenarios)) {
    await t.test(name, async scenario => {
      scenario.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
      const healthAttempts = []
      const readyAt = 30000
      const client = cloudClient('trial', (request, { fail }) => {
        switch (request.path) {
          case '/health':
            healthAttempts.push(Date.now())
            return Date.now() >= readyAt ? ok(healthy) : failWhenCold(request, fail)
          case '/auth/wechat': return ok({ token: 'wechat-session' })
          case '/api/bootstrap': return ok({ me: { role: 'manager', nameBound: true } })
          case '/api/board': return ok({ tables: [] })
          default: assert.fail('意外请求 ' + request.path)
        }
      })
      const access = pageFor('access', client)
      const firstEntry = access.onShow()
      const board = client.api.call('board').catch(error => error)
      await advanceCloud(scenario, 0)
      assert.deepEqual(paths(client.requests), ['/health'])
      assert.equal(client.requests[0].timeout, 15000)
      assert.equal(access.data.checking, true)

      await waitForAccess(scenario, access)
      await firstEntry
      assert.deepEqual(await board, { tables: [] })
      assert.deepEqual(client.navigation, ['/pages/index/index'])
      assert.equal(access.data.error, '')
      assert.ok(healthAttempts.length > 1 && healthAttempts.length <= 4)
      assert.equal(new Set(healthAttempts).size, healthAttempts.length)
      assert.ok(healthAttempts.at(-1) >= readyAt)
      const routes = paths(client.requests)
      assert.deepEqual(routes.slice(0, -2), [...healthAttempts.map(() => '/health'), '/auth/wechat'])
      assert.deepEqual(routes.slice(-2).sort(), ['/api/board', '/api/bootstrap'])
      assert.ok(client.requests.every(request => request.timeout === 15000))
    })
  }
})

test('健康检查遇到权限、环境配置错误或断网时立即结束并显示脱敏错误码', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const scenarios = [
    { respond: () => failure(403, 'PERMISSION_DENIED', privateDetails), code: /HTTP 403/ },
    ...['Path access permission error', 'env not exists'].map(reason => ({
      respond: (_, { fail }) => fail({ errCode: -501000, errMsg: reason + ' ' + privateDetails }),
      code: /微信错误码 -501000/,
    })),
    {
      respond: (_, { fail }) => fail({ ...timedOut, errMsg: 'No internet connection ' + timedOut.errMsg }),
      code: /请连接网络.*微信错误码 -102002/,
    },
  ]
  for (const { respond, code } of scenarios) {
    const client = cloudClient('trial', respond)
    const access = pageFor('access', client)
    const firstEntry = access.onShow()
    await advanceCloud(t, 0)
    assert.equal(access.data.checking, false)
    await firstEntry
    await advanceCloud(t, 60000)
    assert.deepEqual(paths(client.requests), ['/health'])
    assert.match(access.data.error, /门店健康检查/)
    assert.match(access.data.error, code)
    assert.doesNotMatch(access.data.error, privateValues)
  }
})

test('健康检查耗尽重试后可通过手动刷新重新进入门店', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let available = false
  const client = cloudClient('trial', request => {
    switch (request.path) {
      case '/health': return available ? ok(healthy) : failure(503, 'UNAVAILABLE', privateDetails)
      case '/auth/wechat': return ok({ token: 'wechat-session' })
      case '/api/bootstrap': return ok({ me: { role: 'manager', nameBound: true } })
      default: assert.fail('意外请求 ' + request.path)
    }
  })
  const access = pageFor('access', client)
  const firstEntry = access.onShow()
  await waitForAccess(t, access)
  assert.deepEqual(paths(client.requests), ['/health', '/health', '/health', '/health'])
  await firstEntry
  assert.match(access.data.error, /门店健康检查/)
  assert.match(access.data.error, /HTTP 503/)
  assert.doesNotMatch(access.data.error, privateValues)

  available = true
  await access.refresh()
  assert.deepEqual(paths(client.requests).slice(4), ['/health', '/auth/wechat', '/api/bootstrap'])
  assert.deepEqual(client.navigation, ['/pages/index/index'])
  assert.equal(access.data.error, '')
})

test('保存预订遇到传输或网关错误时只发送一次', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const order = { contact: '陈青', phone: '13900009999', guests: 4 }
  const scenarios = [
    { respond: ({ fail }) => fail(timedOut), code: /微信错误码 -102002/ },
    { respond: () => { throw timedOut }, code: /微信错误码 -102002/ },
    { respond: () => failure(503, 'UNAVAILABLE', privateDetails), code: /HTTP 503/ },
    { respond: () => failure(401, 'GATEWAY_UNAUTHORIZED', privateDetails), code: /HTTP 401/ },
  ]
  for (const { respond, code } of scenarios) {
    const { api, requests } = cloudClient('trial', (request, callbacks) => {
      switch (request.path) {
        case '/health': return ok(healthy)
        case '/auth/wechat': return ok({ token: 'test-private-session' })
        case '/api/save': return respond(callbacks)
        default: assert.fail('意外请求 ' + request.path)
      }
    })
    const save = api.call('save', order).catch(error => error)
    await advanceCloud(t, 0)
    await advanceCloud(t, 60000)
    assert.deepEqual(paths(requests), ['/health', '/auth/wechat', '/api/save'])
    assert.equal(requests[2].method, 'POST')
    assert.deepEqual(requests[2].data, order)
    const error = await save
    assert.match(error.message, /门店请求/)
    assert.match(error.message, code)
    assert.doesNotMatch(error.message, privateValues)
  }
})

test('微信登录的请求失败后只在手动重试时重新验证并登录', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let loginFailed = true
  const { api, requests } = cloudClient('trial', request => {
    if (request.path === '/health') return ok(healthy)
    if (request.path === '/auth/wechat') {
      return loginFailed ? Promise.reject({ errno: '-102002', errMsg: privateDetails }) : ok({ token: 'wechat-session' })
    }
    assert.equal(request.path, '/api/bootstrap')
    return ok({ me: { role: 'manager' } })
  })
  const initialLogin = api.call('bootstrap').catch(error => error)
  await advanceCloud(t, 0)
  await advanceCloud(t, 60000)
  assert.deepEqual(paths(requests), ['/health', '/auth/wechat'])
  const error = await initialLogin
  assert.match(error.message, /微信登录.*微信错误码 -102002/)
  assert.doesNotMatch(error.message, privateValues)

  loginFailed = false
  assert.equal((await api.call('bootstrap')).me.role, 'manager')
  assert.deepEqual(paths(requests).slice(2), ['/health', '/auth/wechat', '/api/bootstrap'])
})

test('门店服务返回短信业务错误时保留业务提示', async () => {
  const message = '门店尚未配置签名短信，可以使用手机短信或复制预订消息'
  const { api } = cloudClient('trial', request => {
    if (request.path === '/health') return ok(healthy)
    if (request.path === '/auth/wechat') return ok({ token: 'wechat-session' })
    assert.equal(request.path, '/api/notifySms')
    return failure(503, 'SMS_UNCONFIGURED', message)
  })
  await assert.rejects(api.call('notifySms', { id: 'order-1' }), { code: 'SMS_UNCONFIGURED', message })
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

test('闲置十多分钟后并发刷新共用新健康检查并保留有效会话', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const me = { role: 'manager', nameBound: true }
  let resumed = false
  let completeHealth
  const { api, requests } = cloudClient('trial', (request, { success }) => {
    if (request.path === '/health') {
      if (!resumed) return ok(healthy)
      completeHealth = success
      return
    }
    if (request.path === '/auth/wechat') return ok({ token: 'wechat-session' })
    assert.equal(token(request), 'Bearer wechat-session')
    if (request.path === '/api/bootstrap') return ok({ me })
    if (request.path === '/api/storeOrders') return ok({ orders: [] })
    assert.fail('意外请求 ' + request.path)
  })
  assert.deepEqual(await api.call('bootstrap'), { me })
  assert.deepEqual(paths(requests), ['/health', '/auth/wechat', '/api/bootstrap'])

  await advanceCloud(t, 4 * 60 * 1000)
  assert.deepEqual(await api.call('storeOrders'), { orders: [] })
  await advanceCloud(t, 4 * 60 * 1000)
  assert.deepEqual(await api.call('storeOrders'), { orders: [] })
  assert.deepEqual(paths(requests).slice(3), ['/api/storeOrders', '/api/storeOrders'])

  await advanceCloud(t, 12 * 60 * 1000)
  resumed = true
  const refresh = Promise.all([
    api.call('bootstrap'), api.call('storeOrders', { meal: 'lunch' }),
  ]).catch(error => error)
  await advanceCloud(t, 0)
  assert.deepEqual(paths(requests).slice(5), ['/health'])
  completeHealth(ok(healthy))
  assert.deepEqual(await refresh, [{ me }, { orders: [] }])
  assert.deepEqual(paths(requests).slice(6).sort(), ['/api/bootstrap', '/api/storeOrders'])
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
