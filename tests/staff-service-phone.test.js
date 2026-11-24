const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { today } = require('../miniprogram/lib/domain')
const { openStore } = require('../server/database')
const { createServer } = require('../server')

test('服务手机号的绑定、旧客户端兼容、角色权限与共享持久化', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-staff-phone-test-'))
  const adminPassword = 'unit-only-manager-4GeS'
  const staffPassword = 'unit-only-staff-Q5ac'
  const store = openStore(directory, { adminPassword })
  const second = openStore(directory)
  const server = createServer(store).listen(0, '127.0.0.1')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    store.close()
    second.close()
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('shh-staff-phone-test-')) {
      fs.rmSync(directory, { recursive: true })
    }
  })
  await once(server, 'listening')

  async function post(route, body, token) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
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

  const managerPhone = '13800138000'
  const manager = await login('manager', adminPassword)
  assert.equal((await call('', 'setServicePhone', { servicePhone: managerPhone }, 401)).code, 'UNAUTHORIZED')
  assert.equal((await call(manager, 'setServicePhone', { servicePhone: managerPhone }, 403)).code, 'NAME_REQUIRED')
  await call(manager, 'bindStaffName', { name: '林经理', servicePhone: '' }, 400)
  await call(manager, 'bindStaffName', { name: '林经理', servicePhone: '010-55550100' }, 400)
  assert.equal(second.run('manager', 'bootstrap').me.nameBound, false)

  const managerProfile = await call(manager, 'bindStaffName', { name: '林经理', servicePhone: '+86 (138) 0013-8000' })
  assert.equal(managerProfile.nameBound, true)
  assert.equal(managerProfile.servicePhone, managerPhone)
  assert.deepEqual(second.run('manager', 'bootstrap').me, managerProfile)

  const employee = { id: 'seller', role: 'sales', name: '赵小青' }
  await call(manager, 'staffSave', { ...employee, password: staffPassword })
  const seller = await login(employee.id, staffPassword)
  assert.equal((await call(seller, 'bindStaffName', { name: employee.name })).servicePhone, undefined)
  assert.deepEqual(await call(seller, 'orders'), [])

  const sellerPhone = '15500112233'
  const sellerProfile = await call(seller, 'setServicePhone', { staffId: 'manager', servicePhone: `0086${sellerPhone}` })
  assert.equal(sellerProfile.servicePhone, sellerPhone)
  assert.equal(second.run('manager', 'bootstrap').me.servicePhone, managerPhone)
  assert.equal(second.run(employee.id, 'bootstrap').me.servicePhone, sellerPhone)
  assert.equal((await call(seller, 'bootstrap')).staff.some(person => 'servicePhone' in person), false)
  assert.equal((await call(manager, 'staffRoles')).find(person => person.id === employee.id).servicePhone, sellerPhone)
  assert.equal((await call(seller, 'staffList', {}, 403)).code, 'FORBIDDEN')
  assert.equal((await call(seller, 'staffSave', { ...employee, servicePhone: managerPhone }, 403)).code, 'FORBIDDEN')
  await call(seller, 'setServicePhone', {}, 400)
  assert.equal(second.run(employee.id, 'bootstrap').me.servicePhone, sellerPhone)

  const replacementPhone = '16600112233'
  const booking = {
    date: today(), meal: 'dinner', time: '18:30', tableIds: ['205'], guests: 8,
    contact: '测试客人', phone: '13800000109',
  }
  const oldOrder = await call(seller, 'save', booking)
  const change = {
    id: employee.id, name: ' 赵小妍 ', servicePhone: `+86 ${replacementPhone}`,
    expectedName: employee.name, expectedServicePhone: sellerPhone,
  }
  assert.equal((await call('', 'setStaffProfile', change, 401)).code, 'UNAUTHORIZED')
  assert.equal((await call(seller, 'setStaffProfile', change, 403)).code, 'FORBIDDEN')
  assert.equal((await call(manager, 'setStaffProfile', { ...change, servicePhone: '010-55550100' }, 400)).code, 'VALIDATION')
  assert.equal(second.run(employee.id, 'bootstrap').me.name, employee.name)
  await call(seller, 'setServicePhone', { servicePhone: '' })
  assert.equal((await call(manager, 'setStaffProfile', change, 409)).code, 'VERSION_CONFLICT')
  const edited = await call(manager, 'setStaffProfile', {
    ...change, expectedServicePhone: '', role: 'admin', active: false, password: 'not-applied',
  })
  assert.deepEqual(edited, { ...employee, name: '赵小妍', servicePhone: replacementPhone, nameBound: true, active: true })
  assert.equal(second.run(employee.id, 'bootstrap').me.name, edited.name)
  assert.equal((await call(seller, 'bootstrap')).me.servicePhone, replacementPhone)
  const original = await call(seller, 'notificationDetails', { id: oldOrder.id })
  assert.equal(original.card.serviceName, oldOrder.ownerName)
  assert.equal(original.card.servicePhone, replacementPhone)
  const newOrder = await call(seller, 'save', { ...booking, tableIds: ['206'] })
  assert.equal(newOrder.ownerName, edited.name)
  assert.equal(newOrder.ownerId, oldOrder.ownerId)
  await call(manager, 'setStaffProfile', {
    ...change, name: employee.name, servicePhone: '', expectedName: edited.name, expectedServicePhone: replacementPhone,
  })
  assert.equal(second.run(employee.id, 'bootstrap').me.servicePhone, undefined)

  await call(manager, 'staffSave', { ...employee, name: '错误修改', servicePhone: 16600112233 }, 400)
  assert.equal(second.run(employee.id, 'bootstrap').me.name, employee.name)
  await call(manager, 'staffSave', { ...employee, servicePhone: replacementPhone })
  await call(manager, 'staffSave', { ...employee, name: '赵小妍' })
  const staff = await call(manager, 'staffList')
  assert.equal(staff.find(person => person.id === employee.id).servicePhone, replacementPhone)
  assert.equal((await call(seller, 'bootstrap')).me.servicePhone, replacementPhone)
  await call(seller, 'setServicePhone', { servicePhone: '' })
  assert.equal(second.run(employee.id, 'bootstrap').me.servicePhone, undefined)

  await call(manager, 'staffSave', { id: 'bookkeeper', role: 'finance', name: '王婷婷', password: staffPassword })
  const finance = await login('bookkeeper', staffPassword)
  const financeProfile = await call(finance, 'bindStaffName', { name: '王婷婷', servicePhone: '' })
  assert.equal(financeProfile.nameBound, true)
  assert.equal(financeProfile.servicePhone, undefined)
})
