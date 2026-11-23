const assert = require('node:assert/strict')
const test = require('node:test')
const {seed} = require('./fixtures/store')
const { execute } = require('../miniprogram/lib/domain')

const date = '2030-01-01'
const nextDate = '2030-01-02'
const booking = {
  date, meal: 'dinner', time: '18:00', tableIds: ['101', '102'], guests: 8,
  contact: '林女士', phone: '13800001234', notes: '客人备注',
}

function setup() {
  const state = seed()
  execute(state, 'sales1', 'bindStaffName', { name: '徐' })
  execute(state, 'sales2', 'bindStaffName', { name: '沈佳' })
  execute(state, 'front', 'bindStaffName', { name: '王晓玲' })
  return state
}

function readTable(state, id, filters = {}) {
  return execute(state, 'sales2', 'board', { date, meal: 'dinner', ...filters }).tables.find(table => table.id === id)
}

test('已预订桌位显示原接单员工，按日期与餐段跟随多桌、换桌和订单状态', () => {
  const state = setup()
  const original = execute(state, 'sales1', 'save', booking)
  const lunch = execute(state, 'sales2', 'save', { ...booking, meal: 'lunch', time: '12:00', tableIds: ['101'] })
  execute(state, 'sales2', 'save', { ...booking, date: nextDate, tableIds: ['101'] })

  assert.deepEqual(readTable(state, '101'), {
    ...state.tables[0], orderId: original.id, orderStatus: 'booked', ownerName: '徐',
  })
  assert.equal(readTable(state, '102').ownerName, '徐')
  assert.equal(readTable(state, '101', { meal: 'lunch' }).ownerName, '沈佳')
  assert.equal(readTable(state, '101', { date: nextDate }).ownerName, '沈佳')

  state.staff.find(staff => staff.id === 'sales1').name = '徐晓'
  const moved = execute(state, 'front', 'save', { id: original.id, version: original.version, tableIds: ['102', '103'] })
  assert.deepEqual(readTable(state, '101'), { ...state.tables[0], orderId: null, orderStatus: null })
  assert.equal(readTable(state, '102').ownerName, '徐')
  assert.equal(readTable(state, '103').ownerName, '徐')

  execute(state, 'front', 'cancel', { id: moved.id, version: moved.version })
  assert.deepEqual(readTable(state, '103'), { ...state.tables[2], orderId: null, orderStatus: null })
  const arrived = execute(state, 'front', 'arrive', { id: lunch.id, version: lunch.version })
  assert.deepEqual(readTable(state, '101', { meal: 'lunch' }), {
    ...state.tables[0], orderId: arrived.id, orderStatus: 'arrived',
  })
  execute(state, 'front', 'settle', { id: arrived.id, version: arrived.version, amount: 200 })
  assert.deepEqual(readTable(state, '101', { meal: 'lunch' }), {
    ...state.tables[0], orderId: arrived.id, orderStatus: 'settled',
  })
})

test('旧预订缺少接单姓名时，通过原员工账号查找姓名', () => {
  const state = setup()
  execute(state, 'sales1', 'save', booking)
  delete state.orders[0].ownerName

  assert.equal(readTable(state, '101').ownerName, '徐')

  state.staff = state.staff.filter(staff => staff.id !== 'sales1')
  assert.equal(readTable(state, '101').ownerName, undefined)
})
