const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('../server')
const { applyAction, initialState } = require('../server/store-rules')

test('微信测试入口通过平台身份登记，健康检查和请求体都不会登记员工', async t => {
  const wechatEnv = { WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_CLOUD_ENV: 'test-fixture' }
  const headers = {
    'content-type': 'application/json',
    'x-wx-appid': wechatEnv.WECHAT_APP_ID,
    'x-wx-source': 'wx_client',
    'x-wx-env': wechatEnv.WECHAT_CLOUD_ENV,
    'x-wx-openid': 'fixture-wechat-employee',
  }
  const identities = []
  const server = createServer({
    storage: 'mysql', environment: 'wechat-test', checkHealth: async () => true,
    loginWechat(identity) {
      identities.push(identity)
      return { me: { role: 'pending' } }
    },
  }, { wechatEnv }).listen(0, '127.0.0.1')
  t.after(() => new Promise(resolve => server.close(resolve)))
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`

  const publicHealth = await fetch(base + '/health').then(res => res.json())
  const wechatHealth = await fetch(base + '/health', { headers }).then(res => res.json())
  assert.equal(publicHealth.wechatIdentity, false)
  assert.equal(wechatHealth.wechatIdentity, true)
  assert.equal(wechatHealth.environment, 'wechat-test')
  assert.equal(JSON.stringify(wechatHealth).includes(headers['x-wx-openid']), false)
  assert.deepEqual(identities, [])

  const connect = (requestHeaders, body) => fetch(base + '/auth/wechat', {
    method: 'POST', headers: requestHeaders, body: JSON.stringify(body),
  })
  const suppliedIdentity = { openId: 'forged-employee-open-id', role: 'admin' }
  assert.equal((await connect({ 'content-type': 'application/json' }, suppliedIdentity)).status, 401)
  assert.equal((await connect({ ...headers, 'x-wx-source': '' }, suppliedIdentity)).status, 401)
  assert.equal((await connect({ ...headers, 'x-wx-appid': 'wx1111111111111111' }, suppliedIdentity)).status, 401)
  assert.equal((await connect({ ...headers, 'x-wx-env': 'another-environment' }, suppliedIdentity)).status, 401)
  assert.deepEqual(identities, [])

  const first = await connect(headers, suppliedIdentity)
  assert.equal(first.status, 200)
  assert.equal((await first.json()).me.role, 'pending')
  assert.equal((await connect(headers, {})).status, 200)
  assert.equal(identities.length, 2)
  assert.equal(identities[0], identities[1])
  assert.notEqual(identities[0], headers['x-wx-openid'])
  assert.equal((await fetch(base + '/auth/login', { method: 'POST', headers, body: '{}' })).status, 404)
})

test('待分配账号可登记姓名，获批前只看自己的资料且不能被提升为第二位管理员', () => {
  const state = initialState()
  const employee = { id: 'wx-employee', name: '', role: 'pending', active: true, nameBound: false }
  state.environment = 'wechat-test'
  state.staff = [employee]
  const call = (actor, action, input = {}) => applyAction(state, actor, action, input).result

  const registration = call(employee.id, 'bootstrap')
  assert.equal(registration.canBindAdmin, true)
  assert.equal(registration.store, undefined)
  assert.deepEqual(registration.tables, [])
  assert.deepEqual(registration.staff, [])
  call(employee.id, 'bindStaffName', { name: '林小青' })
  assert.equal(call(employee.id, 'bootstrap').me.name, '林小青')
  for (const action of ['board', 'orders', 'report', 'staffRoles', 'staffList', 'setStaffRole', 'notificationContext']) {
    assert.throws(() => call(employee.id, action), { code: 'ACCESS_PENDING' })
  }

  state.staff.push({ id: 'manager', name: '王经理', role: 'admin', active: true, nameBound: true })
  assert.equal(call(employee.id, 'bootstrap').canBindAdmin, false)
  assert.equal(call('manager', 'bootstrap').staff.some(person => person.id === employee.id), false)
  const listed = call('manager', 'staffRoles').find(person => person.id === employee.id)
  assert.equal(listed.role, 'pending')
  const assignment = { id: employee.id, expectedRole: listed.role }
  assert.throws(() => call('manager', 'setStaffRole', { ...assignment, role: 'admin' }), { code: 'VALIDATION' })
  assert.equal(call('manager', 'setStaffRole', { ...assignment, role: 'finance' }).role, 'finance')
  assert.throws(() => call('manager', 'setStaffRole', { ...assignment, role: 'sales' }), { code: 'VERSION_CONFLICT' })
  assert.equal(call(employee.id, 'bootstrap').me.role, 'finance')
  assert.throws(() => call(employee.id, 'staffRoles'), { code: 'FORBIDDEN' })
  assert.equal(call('manager', 'setStaffRole', { id: employee.id, expectedRole: 'finance', role: 'manager' }).role, 'manager')
  assert.equal(call(employee.id, 'bootstrap').me.role, 'manager')
  assert.throws(() => call(employee.id, 'setStaffRole', { id: employee.id, role: 'admin', expectedRole: 'manager' }), { code: 'FORBIDDEN' })
  assert.equal(call('manager', 'setStaffRole', { id: employee.id, expectedRole: 'manager', role: 'pending' }).role, 'pending')
  assert.throws(() => call(employee.id, 'report'), { code: 'ACCESS_PENDING' })
})
