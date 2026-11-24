const assert = require('node:assert/strict')
const test = require('node:test')
const {seed} = require('./fixtures/store')
const { execute, today } = require('../miniprogram/lib/domain')

function shiftDate(date, days) {
  const result = new Date(`${date}T00:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

function booking(date, fields = {}) {
  return {
    date, meal: 'dinner', time: '18:00', tableIds: ['201'], guests: 8,
    contact: '顾客', phone: '13800001234', ...fields,
  }
}

function readyStore() {
  const state = seed()
  const names = { front: '王晓玲', manager: '林树', finance: '陈伟' }
  for (const person of state.staff) execute(state, person.id, 'bindStaffName', { name: names[person.id] || person.name })
  return state
}

function tableOnBoard(state, date, meal, id) {
  return execute(state, 'finance', 'board', { date, meal }).tables.find(table => table.id === id)
}

test('同餐段的一单多桌同时占用，失败的抢桌和换桌保留既有状态', () => {
  const state = readyStore()
  const date = today()
  const first = execute(state, 'sales1', 'save', booking(date, { tableIds: ['202'] }))
  const pending = booking(date, { tableIds: ['201', '202'], contact: '林女士' })
  const beforeConflict = JSON.stringify(state)

  assert.throws(() => execute(state, 'sales2', 'save', pending), error => {
    assert.equal(error.code, 'TABLE_CONFLICT')
    assert.deepEqual(error.tableIds, ['202'])
    return true
  })
  assert.equal(JSON.stringify(state), beforeConflict)
  assert.deepEqual(pending.tableIds, ['201', '202'])
  assert.equal(tableOnBoard(state, date, 'dinner', '201').orderId, null)

  const second = execute(state, 'sales2', 'save', { ...pending, tableIds: ['201', '203'] })
  assert.equal(second.contact, '林女士')
  assert.equal(execute(state, 'front', 'board', { date, meal: 'dinner' }).guestCount, 16)
  assert.throws(() => execute(state, 'front', 'save', {
    id: first.id, version: first.version, tableIds: ['203'],
  }), { code: 'TABLE_CONFLICT' })
  assert.equal(tableOnBoard(state, date, 'dinner', '202').orderId, first.id)
  assert.equal(tableOnBoard(state, date, 'dinner', '203').orderId, second.id)

  const lunch = execute(state, 'sales1', 'save', booking(date, { meal: 'lunch', time: '11:30', tableIds: ['202'] }))
  assert.equal(tableOnBoard(state, date, 'lunch', '202').orderId, lunch.id)
  const cancelled = execute(state, 'sales2', 'cancel', { id: second.id, version: second.version })
  const switched = execute(state, 'front', 'save', { id: first.id, version: first.version, tableIds: ['203'] })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(tableOnBoard(state, date, 'dinner', '202').orderId, null)
  assert.equal(tableOnBoard(state, date, 'dinner', '203').orderId, switched.id)
  assert.equal(tableOnBoard(state, date, 'lunch', '202').orderId, lunch.id)
  assert.throws(() => execute(state, 'front', 'cancel', { id: first.id, version: first.version }), { code: 'VERSION_CONFLICT' })
})

test('其他营销员工仅能查看遮号订单，店长代改保留接单人和操作记录', () => {
  const state = readyStore()
  const date = today()
  const order = execute(state, 'sales1', 'save', booking(date, { deposit: '200.25', depositMethod: '微信' }))
  const other = execute(state, 'sales2', 'order', { id: order.id })
  assert.equal(other.phone, '138****1234')
  assert.equal(other.canEdit, false)
  assert.deepEqual(other.logs, [])
  assert.equal(execute(state, 'sales1', 'order', { id: order.id }).phone, '13800001234')
  assert.deepEqual(execute(state, 'sales2', 'orders', { phone: '13800001234' }), [])
  assert.equal(execute(state, 'sales2', 'customer', { phone: '13800001234' }), null)
  assert.equal(execute(state, 'sales1', 'customer', { phone: '138 0000 1234' }).orders[0].id, order.id)
  assert.throws(() => execute(state, 'sales2', 'save', { id: order.id, version: order.version }), { code: 'FORBIDDEN' })
  assert.throws(() => execute(state, 'sales2', 'cancel', { id: order.id, version: order.version }), { code: 'FORBIDDEN' })
  assert.throws(() => execute(state, 'sales1', 'settle', { id: order.id, version: order.version, amount: 500 }), { code: 'FORBIDDEN' })
  assert.throws(() => execute(state, 'finance', 'customer', { phone: '13800001234' }), { code: 'FORBIDDEN' })

  const changed = execute(state, 'front', 'save', {
    id: order.id, version: order.version, tableIds: ['202'], deposit: 300, depositMethod: '现金',
  })
  execute(state, 'front', 'cancel', { id: order.id, version: changed.version })
  state.staff.find(staff => staff.id === 'front').name = '店长新姓名'
  const audited = execute(state, 'manager', 'order', { id: order.id })
  assert.equal(audited.ownerId, 'sales1')
  assert.equal(audited.createdDate, date)
  assert.equal(audited.depositHandler, '王晓玲')
  assert.deepEqual(audited.logs.slice(-3).map(log => log.actorId), ['front', 'front', 'front'])
  assert.deepEqual(audited.logs.slice(-3).map(log => log.actorName), ['王晓玲', '王晓玲', '王晓玲'])
  assert.match(audited.logs.at(-3).action, /换桌.*201.*202/)
  assert.match(audited.logs.at(-2).action, /修改订金.*200\.25.*300/)
  assert.equal(audited.logs.at(-1).action, '取消订单')
})

test('店长散客只填桌位和人数即可到店，在日报中单列', () => {
  const state = readyStore()
  const date = today()
  const walkin = execute(state, 'front', 'save', { kind: 'walkin', tableIds: ['101'], guests: 4 })
  assert.equal(walkin.date, date)
  assert.equal(walkin.status, 'arrived')
  assert.equal(walkin.contact, '')
  assert.equal(walkin.phone, '')
  assert.equal(execute(state, 'sales1', 'board', { date, meal: walkin.meal }).guestCount, 4)
  assert.equal(tableOnBoard(state, date, walkin.meal, '101').orderStatus, 'arrived')
  assert.throws(() => execute(state, 'sales1', 'save', { kind: 'walkin', tableIds: ['102'], guests: 4 }), { code: 'FORBIDDEN' })

  const settled = execute(state, 'front', 'settle', { id: walkin.id, version: walkin.version, amount: '0.00' })
  assert.equal(tableOnBoard(state, date, walkin.meal, '101').orderId, settled.id)
  const report = execute(state, 'finance', 'report', { date })
  assert.deepEqual(report.rows.find(row => row.staffId === 'walkin'), {
    staffId: 'walkin', name: '散客', orderCount: 1, tableCount: 1, amount: 0, pending: 0, deposit: 0,
  })
  assert.equal(report.rows.find(row => row.staffId === 'front').orderCount, 0)
})

test('日报按用餐日和原接单人统计，已抵扣订金单列且不重复计入消费', () => {
  let state = readyStore()
  const date = today()
  const createdDate = shiftDate(date, -1)
  const [order] = execute(state, 'manager', 'import', { orders: [booking(date, {
    ownerId: 'sales1', createdDate, tableIds: ['201', '202'], deposit: 500, depositMethod: '微信',
  })] })
  const cancelled = execute(state, 'sales2', 'save', booking(date, {
    tableIds: ['203'], deposit: 100.01, depositMethod: '微信',
  }))
  execute(state, 'front', 'cancel', { id: cancelled.id, version: cancelled.version })
  let report = execute(state, 'finance', 'report', { date })
  assert.deepEqual(report.total, { orderCount: 1, tableCount: 2, amount: 0, pending: 1, deposit: 500 })

  // The same records must survive JSON storage between check-in and the report.
  state = JSON.parse(JSON.stringify(state))
  const arrived = execute(state, 'front', 'arrive', { id: order.id, version: order.version })
  const settled = execute(state, 'front', 'settle', { id: order.id, version: arrived.version, amount: 2400 })
  assert.equal(settled.amount, 2400)
  assert.equal(settled.ownerId, 'sales1')

  report = execute(state, 'finance', 'report', { date, basis: 'meal' })
  assert.equal(report.period, 'day')
  assert.equal(report.basis, 'meal')
  assert.deepEqual(report.total, { orderCount: 1, tableCount: 2, amount: 2400, pending: 0, deposit: 500 })
  assert.equal(report.rows.find(row => row.staffId === 'sales1').amount, 2400)
  assert.equal(report.details.filter(detail => detail.id === order.id).length, 1)
  assert.equal(report.details.find(detail => detail.id === cancelled.id).status, 'cancelled')
  assert.equal(report.details.find(detail => detail.id === cancelled.id).deposit, 100.01)

  const yesterday = execute(state, 'finance', 'report', { date: createdDate, basis: 'created' })
  assert.deepEqual(yesterday.total, { orderCount: 0, tableCount: 0, amount: 0, pending: 0, deposit: 0 })
  assert.deepEqual(yesterday.details, [])
  assert.deepEqual(execute(state, 'finance', 'report', { date, basis: 'created' }), report)
})

test('财务补录缺失的消费金额，保留订金和遮号，已录金额由店长更正', () => {
  const state = readyStore()
  const date = today()
  const order = execute(state, 'sales1', 'save', booking(date, {
    deposit: 500, depositMethod: '微信', notes: '生日桌',
  }))
  const arrival = execute(state, 'front', 'arrive', { id: order.id, version: order.version })
  const input = { id: order.id, version: arrival.version }
  const pending = execute(state, 'finance', 'report', { date }).details[0]
  assert.equal(pending.canSettle, true)
  assert.equal(pending.phone, '138****1234')
  assert.throws(() => execute(state, 'finance', 'save', { ...input, deposit: 20 }), { code: 'FORBIDDEN' })
  assert.throws(() => execute(state, 'finance', 'cancel', input), { code: 'FORBIDDEN' })
  assert.throws(() => execute(state, 'finance', 'settle', { ...input, version: order.version, amount: 2400 }), { code: 'VERSION_CONFLICT' })

  const settled = execute(state, 'finance', 'settle', { ...input, amount: 2400, deposit: 0, notes: '替换' })
  assert.equal(settled.status, 'settled')
  assert.equal(settled.phone, '138****1234')
  assert.equal(settled.canSettle, false)
  assert.equal(settled.deposit, 500)
  assert.equal(settled.notes, '生日桌')
  const adjustment = { id: order.id, version: settled.version, amount: 2450 }
  assert.throws(() => execute(state, 'finance', 'settle', adjustment), { code: 'VALIDATION' })
  assert.equal(execute(state, 'front', 'settle', adjustment).amount, 2450)
  assert.deepEqual(execute(state, 'finance', 'report', { date }).total, {
    orderCount: 1, tableCount: 1, amount: 2450, pending: 0, deposit: 500,
  })
})

test('月报按用餐年月汇总跨月接单，保留员工明细和金额精度', () => {
  const state = readyStore()
  const instant = new Date('2026-02-02T10:00:00+08:00')
  const [last, first, pending, cancelled] = execute(state, 'manager', 'import', { orders: [
    booking('2026-01-31', { ownerId: 'sales1', createdDate: '2026-01-15', deposit: 0.2, depositMethod: '微信' }),
    booking('2026-01-01', { ownerId: 'sales1', createdDate: '2025-12-31', deposit: 0.1, depositMethod: '微信' }),
    booking('2026-01-31', { ownerId: 'sales2', createdDate: '2026-01-29', tableIds: ['202'], time: '19:00' }),
    booking('2026-01-31', { ownerId: 'sales2', createdDate: '2026-01-30', tableIds: ['203'], time: '20:00', deposit: 99, depositMethod: '现金' }),
    booking('2026-02-01', { ownerId: 'sales2', createdDate: '2026-01-25' }),
    booking('2025-12-31', { ownerId: 'sales1', createdDate: '2025-12-30' }),
    booking('2025-01-31', { ownerId: 'sales1', createdDate: '2025-01-30' }),
  ] }, instant)
  execute(state, 'front', 'settle', { id: first.id, version: first.version, amount: 0.1 }, instant)
  execute(state, 'front', 'settle', { id: last.id, version: last.version, amount: 0.2 }, instant)
  execute(state, 'front', 'cancel', { id: cancelled.id, version: cancelled.version }, instant)

  const date = '2026-01-15'
  const report = execute(state, 'finance', 'report', { date, period: 'month' })
  assert.equal(report.date, date)
  assert.equal(report.period, 'month')
  assert.equal(report.basis, 'meal')
  assert.deepEqual(report.total, { orderCount: 3, tableCount: 3, amount: 0.3, pending: 1, deposit: 0.3 })
  assert.deepEqual(report.rows.find(row => row.staffId === 'sales1'), {
    staffId: 'sales1', name: '小李', orderCount: 2, tableCount: 2, amount: 0.3, pending: 0, deposit: 0.3,
  })
  assert.deepEqual(report.details.map(order => order.id), [first.id, last.id, pending.id, cancelled.id])
  assert.deepEqual(execute(state, 'finance', 'report', { date, period: 'month', basis: 'created' }), report)
  assert.throws(() => execute(state, 'finance', 'report', { date: '2026-01', period: 'month' }), { code: 'VALIDATION' })
  assert.throws(() => execute(state, 'finance', 'report', { date: '2026-02-29', period: 'month' }), { code: 'VALIDATION' })
  assert.throws(() => execute(state, 'finance', 'report', { date, period: 'week' }), { code: 'VALIDATION' })
})

test('店长逐笔或批量录入存量预订，失败时不会部分占桌或删除已用桌', () => {
  const state = readyStore()
  const date = shiftDate(today(), 1)
  const original = { ownerId: 'sales1', createdDate: today() }
  const planned = booking(date, { ...original, tableIds: ['201', '202'] })
  assert.throws(() => execute(state, 'front', 'save', planned), { code: 'FORBIDDEN' })
  const initial = JSON.stringify(state)
  assert.throws(() => execute(state, 'manager', 'import', {
    orders: [planned, booking(date, { ...original, tableIds: ['202'] })],
  }), { code: 'TABLE_CONFLICT', row: 2 })
  assert.equal(JSON.stringify(state), initial)
  const [imported] = execute(state, 'manager', 'import', { orders: [planned] })
  assert.equal(imported.ownerId, 'sales1')
  assert.equal(imported.createdDate, original.createdDate)
  assert.equal(tableOnBoard(state, date, 'dinner', '201').orderId, imported.id)

  const beforeConfiguration = JSON.stringify(state)
  assert.throws(() => execute(state, 'manager', 'configure', {
    store: { name: '更新的店名' }, tables: state.tables.filter(table => table.id !== '201'),
  }), { code: 'VALIDATION' })
  assert.equal(JSON.stringify(state), beforeConfiguration)
  const configured = execute(state, 'manager', 'configure', {
    store: { name: '更新的店名' }, tables: state.tables.filter(table => table.id !== '203'),
  })
  assert.equal(configured.store.name, '更新的店名')
  assert.equal(configured.tables.some(table => table.id === '203'), false)
  assert.equal(tableOnBoard(state, date, 'dinner', '202').orderId, imported.id)
})

test('桌位类型和容量待补充时仍可建单，补充桌位资料继续保留占用', () => {
  const state = readyStore()
  const date = today()
  const config = execute(state, 'manager', 'configure', {
    store: { name: '珊瑚海', address: '', phone: '' },
    tables: [
      { id: '201', name: '201', floor: '二楼', type: 'unknown', capacity: null },
      { id: '202', name: '202', floor: '二楼', type: 'unknown', capacity: '' },
    ],
  })
  assert.deepEqual(config.store, { name: '珊瑚海', address: '', phone: '' })
  assert.deepEqual(config.tables.map(table => table.capacity), [null, null])

  const order = execute(state, 'sales1', 'save', booking(date, { tableIds: ['201', '202'] }))
  const [first, second] = config.tables
  assert.throws(() => execute(state, 'manager', 'configure', {
    tables: [{ ...first, capacity: 3.5 }, second],
  }), { code: 'VALIDATION' })
  execute(state, 'manager', 'configure', {
    tables: [{ ...first, type: 'room', capacity: '8' }, second],
  })
  const table = tableOnBoard(state, date, 'dinner', '201')
  assert.equal(table.type, 'room')
  assert.equal(table.capacity, 8)
  assert.equal(table.orderId, order.id)
  assert.equal(tableOnBoard(state, date, 'dinner', '202').orderId, order.id)
})
