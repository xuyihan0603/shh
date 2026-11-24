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
  assert.equal((await call(manager, 'setStaffRole', { ...roleChange, id: 'manager', role: 'sales', expectedRole: 'admin' }, 400)).code, 'VALIDATION')
  assert.equal((await call(manager, 'staffSave', { ...employee, role: 'admin' }, 400)).code, 'VALIDATION')
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
  assert.equal((await call(promoted, 'staffRoles', {}, 403)).code, 'FORBIDDEN')
  assert.equal((await call(promoted, 'configure', { store: { name: '新店名' } }, 403)).code, 'FORBIDDEN')
  assert.equal((await call(promoted, 'storeOrders')).orders[0].id, order.id)
  assert.equal((await call(promoted, 'report')).total.orderCount, 1)
  assert.deepEqual(stores[1].read().orders.find(item => item.id === order.id), originalOrder)

  const paused = { id: 'paused', name: '许小晨', role: 'sales', active: false }
  await call(manager, 'staffSave', { ...paused, password: staffPassword })
  const changed = await call(manager, 'setStaffRole', { id: paused.id, role: 'finance', expectedRole: paused.role })
  assert.equal(changed.active, false)

  await call(manager, 'staffSave', { ...revised, role: 'finance' })
  assert.equal((await call(promoted, 'staffRoles', {}, 401)).code, 'UNAUTHORIZED')
})

test('旧门店数据库重开时保留原管理员身份、登录和历史记录', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-staff-migration-test-'))
  const password = 'unit-only-legacy-admin'
  const original = openStore(directory, { adminPassword: password })
  const stores = [original]
  t.after(() => {
    for (const store of stores) store.close()
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('shh-staff-migration-test-')) {
      fs.rmSync(directory, { recursive: true })
    }
  })

  original.run('manager', 'bindStaffName', { name: '林经理' })
  const { token } = original.login('manager', password)
  const order = original.run('manager', 'save', {
    date: today(), meal: 'dinner', time: '18:30', tableIds: ['201'], guests: 4, contact: '测试顾客', phone: '13800000109',
  })
  const legacy = original.read()
  const front = { id: 'front', name: '俞小梅', role: 'front', nameBound: true, servicePhone: '15500112233' }
  const manager = { id: 'shop-lead', name: '郑经理', role: 'manager', nameBound: true }
  legacy.staff[0].role = 'manager'
  legacy.staff.push(front, manager)
  original.db.prepare('UPDATE business SET snapshot=? WHERE id=1').run(JSON.stringify(legacy))

  const migrated = openStore(directory)
  stores.push(migrated)
  assert.equal(migrated.authenticate(token), 'manager')
  assert.equal(migrated.login('manager', password).me.role, 'admin')
  const current = migrated.read()
  assert.deepEqual(current.staff, [{ ...legacy.staff[0], role: 'admin' }, { ...front, role: 'sales' }, manager])
  assert.deepEqual(current.orders, legacy.orders)
  assert.equal(migrated.run('manager', 'order', { id: order.id }, token).ownerId, 'manager')
  const reopened = openStore(directory)
  stores.push(reopened)
  assert.deepEqual(reopened.read(), current)
})
