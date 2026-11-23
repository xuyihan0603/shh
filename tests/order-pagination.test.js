const test = require('node:test')
const assert = require('node:assert/strict')
const { seed } = require('./fixtures/store')
const { execute } = require('../miniprogram/lib/domain')
const { shiftDate } = require('../miniprogram/lib/reception')

function booking(date, meal = 'lunch') {
  return { date, meal, time: meal === 'lunch' ? '12:30' : '18:00', tableIds: ['201'], guests: 4, contact: '陈女士', phone: '13800000109' }
}

test('店长按创建顺序跨日期分页，插入新单后从旧游标继续且单日接口保持可用', () => {
  const state = seed()
  execute(state, 'manager', 'bindStaffName', { name: '林经理' })
  execute(state, 'front', 'bindStaffName', { name: '王小晴' })
  execute(state, 'sales1', 'bindStaffName', { name: '陈小欢' })
  const managerOrders = input => execute(state, 'manager', 'storeOrders', { meal: 'lunch', ...input })
  const firstDate = '2026-03-01'
  const lunchOrders = Array.from({ length: 28 }, (_, index) => {
    const date = shiftDate(firstDate, -index)
    return execute(state, 'sales1', 'save', booking(date))
  })
  execute(state, 'front', 'save', booking(firstDate, 'dinner'))
  const latestFirst = lunchOrders.map(order => order.id).reverse()
  const ids = orders => orders.map(order => order.id)

  assert.throws(() => execute(state, 'front', 'storeOrders', { meal: 'lunch' }), { code: 'FORBIDDEN' })
  assert.throws(() => execute(state, 'sales1', 'storeOrders', { meal: 'lunch' }), { code: 'FORBIDDEN' })
  const firstPage = managerOrders()
  assert.equal(firstPage.total, 28)
  assert.deepEqual(ids(firstPage.orders), latestFirst.slice(0, 25))
  assert.equal(firstPage.next, latestFirst[24])

  const inserted = execute(state, 'front', 'save', booking(shiftDate(firstDate, 1)))
  const secondPage = managerOrders({ beforeId: firstPage.next })
  assert.equal(secondPage.total, 29)
  assert.equal(secondPage.next, '')
  assert.deepEqual(ids(firstPage.orders.concat(secondPage.orders)), latestFirst)
  assert.equal(managerOrders().orders[0].id, inserted.id)

  const daily = execute(state, 'sales1', 'orders', { date: firstDate, meal: 'lunch' })
  assert.deepEqual(daily, [lunchOrders[0]])
})
