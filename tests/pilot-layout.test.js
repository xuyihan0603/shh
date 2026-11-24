const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execute } = require('../miniprogram/lib/domain')
const { openStore } = require('../server/database')
const { ADMIN_ID } = require('../server/store-rules')
const { pilotLayout, applyPilotTableLayout } = require('../miniprogram/lib/pilot')

test('打开已有门店会更正旧桌号并保留预订占用和自定义桌位', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-layout-test-'))
  let store
  t.after(() => {
    store?.close()
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file))
    fs.rmdirSync(directory)
  })

  store = openStore(directory, { adminPassword: 'test-layout-only' })
  const snapshot = store.read()
  delete snapshot.pilotTableLayoutApplied
  Object.assign(snapshot.staff[0], { name: '徐领班', nameBound: true })
  const extra = { id: 'terrace', name: '露台桌', floor: '露台', type: 'hall', capacity: 12 }
  snapshot.tables = [
    { id: '204', name: '204', floor: '二楼', type: 'unknown', capacity: null },
    { id: '卡1', name: '卡1', floor: '待确认', type: 'unknown', capacity: null },
    { id: '阳光房B1', name: '阳光房B1', floor: '待确认', type: 'unknown', capacity: null },
    { id: '309', name: '309', floor: '三楼', type: 'room', capacity: 5 },
    extra,
  ]
  const date = '2030-01-05'
  const order = execute(snapshot, ADMIN_ID, 'save', {
    date, meal: 'dinner', time: '18:00', tableIds: ['204', '卡1'],
    guests: 14, contact: '测试联系人', phone: '13800000001',
  })
  store.db.prepare('UPDATE business SET snapshot=? WHERE id=1').run(JSON.stringify(snapshot))
  store.close()
  store = openStore(directory)

  const board = store.run(ADMIN_ID, 'board', { date, meal: 'dinner' })
  const corrected = board.tables.find(table => table.id === '203')
  assert.deepEqual(corrected, {
    id: '203', name: '203', floor: '二楼', type: 'room', minCapacity: 12, capacity: 14,
    orderId: order.id, orderStatus: 'booked', ownerName: '徐领班',
  })
  assert.ok(!board.tables.some(table => table.id === '204'))
  assert.equal(board.tables.find(table => table.id === '卡1').orderId, order.id)
  assert.equal(board.tables.find(table => table.id === '卡1').floor, '一楼')
  assert.equal(board.tables.find(table => table.id === '阳光房B1').floor, '二楼')
  assert.equal(board.tables.find(table => table.id === '309').capacity, 5)
  assert.deepEqual(store.read().tables.at(-1), extra)
  assert.deepEqual(store.run(ADMIN_ID, 'order', { id: order.id }), {
    ...order, tableIds: ['203', '卡1'], tableNames: ['203', '卡1'],
  })

  const { tables } = store.run(ADMIN_ID, 'bootstrap')
  const invalid = tables.map(table => table.id === '203' ? { ...table, minCapacity: 15 } : table)
  assert.throws(() => store.run(ADMIN_ID, 'configure', { tables: invalid }), { code: 'VALIDATION' })

  const edited = tables.map(table => table.id === '203' ? { ...table, minCapacity: 11 } : table)
  store.run(ADMIN_ID, 'configure', { tables: edited })
  store.close()
  store = openStore(directory)
  assert.equal(store.run(ADMIN_ID, 'bootstrap').tables.find(table => table.id === '203').minCapacity, 11)
})

test('上一版已配置的门店只增补四张一楼散台，保留已有自定义容量和桌名', () => {
  const state = pilotLayout()
  delete state.pilotHallTablesApplied
  const halls = ['厅1', '厅2', '厅3', '厅5']
  state.tables = state.tables.filter(table => !halls.includes(table.name))
  state.tables.find(table => table.id === '103').name = '海景房'
  const existing = { id: 'hall-2', name: '厅2', floor: '一楼', type: 'hall', minCapacity: 5, capacity: 7 }
  state.tables.splice(4, 0, existing)
  assert.equal(applyPilotTableLayout(state), true)
  const additions = state.tables.filter(table => halls.includes(table.name))
  assert.equal(state.tables.length, 28)
  assert.equal(additions.length, 4)
  assert.ok(additions.every(table => table.floor === '一楼' && table.type === 'hall'))
  assert.ok(additions.filter(table => table !== existing).every(table => table.minCapacity === null && table.capacity === null))
  assert.equal(state.tables.find(table => table.name === '厅2'), existing)
  assert.equal(state.tables.find(table => table.id === '103').name, '海景房')
  state.tables.find(table => table.name === '厅1').name = '临窗桌'
  assert.equal(applyPilotTableLayout(state), false)
  assert.equal(state.tables.length, 28)
})

test('店长和管理员分桌维护，更新已占桌的资料后原订单和占用仍一致', () => {
  const state = require('../miniprogram/lib/domain').seed()
  Object.assign(state.staff[0], { name: '张明', nameBound: true })
  for (const role of ['finance', 'manager', 'sales']) state.staff.push({ id: 'user-' + role, role, name: '郑阳', nameBound: true })
  const table = { name: '临窗桌', floor: '一楼', type: 'hall', minCapacity: '', capacity: '' }
  for (const role of ['sales', 'finance']) {
    assert.throws(() => execute(state, 'user-' + role, 'saveTable', { table }), { code: 'FORBIDDEN' })
  }
  const original = execute(state, 'user-manager', 'saveTable', { table })
  assert.throws(() => execute(state, ADMIN_ID, 'saveTable', { table }), { code: 'VALIDATION' })
  const second = execute(state, ADMIN_ID, 'saveTable', { table: { ...table, floor: '二楼' } })
  assert.notEqual(second.id, original.id)
  const slot = { date: '2030-01-06', meal: 'dinner' }
  const booking = execute(state, 'user-sales', 'save', { ...slot, time: '18:00', tableIds: [original.id], guests: 3, contact: '陈先生', phone: '13800000001' })
  const data = { id: original.id, expected: original, table: { ...table, name: '窗边1', minCapacity: 4, capacity: 6 } }
  execute(state, ADMIN_ID, 'saveTable', data)
  assert.throws(() => execute(state, 'user-manager', 'saveTable', data), { code: 'VERSION_CONFLICT' })
  const order = execute(state, 'user-sales', 'order', { id: booking.id })
  assert.deepEqual(order.tableNames, ['窗边1'])
  assert.equal(order.version, booking.version + 1)
  assert.equal(execute(state, ADMIN_ID, 'board', slot).tables.find(t => t.id === original.id).orderId, booking.id)
})
