const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { today } = require('../miniprogram/lib/domain')
const { openStore } = require('../server/database')
const { createServer } = require('../server')

test('共享服务仅更新职位，拒绝过期更新并撤销目标员工的会话', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-staff-roles-test-'))
  const adminPassword = 'unit-only-manager-62'
  const stores = [openStore(directory, { adminPassword }), openStore(directory)]
  const servers = stores.map(store => createServer(store).listen(0, '127.0.0.1'))
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    for (const store of stores) store.close()
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('shh-staff-roles-test-')) {
      fs.rmSync(directory, { recursive: true })
    }
  })
  await Promise.all(servers.map(server => once(server, 'listening')))

  async function post(route, body, token, server = 0) {
    const response = await fetch(`http://127.0.0.1:${servers[server].address().port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: response.status, data: await response.json() }
  }
  async function login(staffId, password) {
    const { status, data } = await post('/auth/login', { staffId, password })
    assert.equal(status, 200, data.error)
    return data.token
  }
  async function call(token, action, body = {}, expectedStatus = 200) {
    const { status, data } = await post(`/api/${action}`, body, token)
    assert.equal(status, expectedStatus, data.error)
    return data
  }

  const manager = await login('manager', adminPassword)
  assert.equal((await call(manager, 'staffRoles', {}, 403)).code, 'NAME_REQUIRED')
  await call(manager, 'bindStaffName', { name: '林经理' })
  const employee = { id: 'seller', name: '赵小青', role: 'sales' }
  const staffPassword = 'unit-only-staff-initial'
  await call(manager, 'staffSave', { ...employee, password: staffPassword })
  const oldSession = await login(employee.id, staffPassword)
  await call(oldSession, 'bindStaffName', { name: employee.name, servicePhone: '15500112233' })
  const order = await call(oldSession, 'save', {
    date: today(), meal: 'lunch', time: '12:30', tableIds: ['201'], guests: 4, contact: '测试顾客', phone: '13800000109',
  })
  const originalOrder = stores[0].read().orders.find(item => item.id === order.id)

  const roster = await call(manager, 'staffRoles')
  const current = roster.find(person => person.id === employee.id)
  assert.deepEqual(current, { ...employee, active: true, nameBound: true })
  const roleChange = { id: current.id, role: 'manager', expectedRole: current.role }
  assert.equal((await call(oldSession, 'staffRoles', {}, 403)).code, 'FORBIDDEN')
  assert.equal((await call(oldSession, 'setStaffRole', roleChange, 403)).code, 'FORBIDDEN')
  assert.equal((await call(manager, 'setStaffRole', { ...roleChange, id: 'manager', role: 'front', expectedRole: 'manager' }, 400)).code, 'VALIDATION')
  assert.equal((await call(manager, 'setStaffRole', { id: current.id, role: 'manager' }, 400)).code, 'VALIDATION')

  const revised = { ...employee, name: '赵小妍', servicePhone: '16600112233' }
  const currentPassword = 'unit-only-staff-revised'
  await call(manager, 'staffSave', { ...revised, password: currentPassword })
  const sessions = [await login(current.id, currentPassword), await login(current.id, currentPassword)]
  const staleForm = { ...roleChange, name: current.name, servicePhone: '', active: false, password: staffPassword }
  const updates = await Promise.all(servers.map((_, index) => post('/api/setStaffRole', staleForm, manager, index)))
  assert.deepEqual(updates.map(update => update.status).sort(), [200, 409])
  assert.equal(updates.find(update => update.status === 409).data.code, 'VERSION_CONFLICT')
  assert.deepEqual(updates.find(update => update.status === 200).data, {
    id: current.id, name: revised.name, role: 'manager', active: true, nameBound: true,
  })
  for (const session of sessions) assert.equal((await call(session, 'bootstrap', {}, 401)).code, 'UNAUTHORIZED')

  const promoted = await login(current.id, currentPassword)
  await call(manager, 'setStaffRole', { id: current.id, role: 'manager', expectedRole: 'manager' })
  assert.equal((await call(promoted, 'bootstrap')).me.servicePhone, revised.servicePhone)
  assert.ok((await call(promoted, 'staffRoles')).some(person => person.id === 'manager'))
  assert.deepEqual(stores[1].read().orders.find(item => item.id === order.id), originalOrder)

  const paused = { id: 'paused', name: '许小晨', role: 'front', active: false }
  await call(manager, 'staffSave', { ...paused, password: staffPassword })
  const changed = await call(manager, 'setStaffRole', { id: paused.id, role: 'finance', expectedRole: paused.role })
  assert.equal(changed.active, false)

  await call(manager, 'staffSave', { ...revised, role: 'finance' })
  assert.equal((await call(promoted, 'staffRoles', {}, 401)).code, 'UNAUTHORIZED')
})
