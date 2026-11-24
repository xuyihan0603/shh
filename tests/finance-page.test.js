const test = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {runInNewContext} = require('node:vm')
const {seed} = require('./fixtures/store')
const {execute, today} = require('../miniprogram/lib/domain')
const reception = require('../miniprogram/lib/reception')

const testDay = new Date('2026-11-23T10:30:00+08:00')

function mountPage(route, api, wx = {}) {
  let page
  runInNewContext(readFileSync(require.resolve(`../miniprogram/pages/${route}/index.js`), 'utf8'), {
    Page(definition) { page = definition },
    require(name) { return name.endsWith('/reception') ? reception : api },
    wx,
  })
  page.setData = (update, done) => {
    for (const [field, value] of Object.entries(update)) {
      const item = /^details\[(\d+)\]$/.exec(field)
      if (item) page.data.details[Number(item[1])] = value
      else page.data[field] = value
    }
    if (done) done()
  }
  return page
}

test('月报补录后返回保留日期和员工待补筛选，切换账号后重新验证权限', async t => {
  t.mock.timers.enable({apis: ['Date'], now: testDay})
  const state = seed()
  for (const person of state.staff) person.nameBound = true
  const date = today()
  const book = (ownerId, tableId) => execute(state, ownerId, 'save', {
    date, meal:'lunch', time:'12:00', tableIds:[tableId], guests:3, contact:'订单测试', phone:'00000008'
  })
  const pendingBooking = book('front','101')
  execute(state, 'front', 'arrive', {id:pendingBooking.id,version:pendingBooking.version})
  book('sales1','201')
  let actor = 'manager'
  let refreshStops = 0
  const routes = []
  const exports = []
  const api = {
    today,
    async call(action, input) {
      return execute(state, actor, action, input)
    },
    async openReport(date, period) { exports.push([date, period]) },
  }
  const wx = {
    navigateTo({url}) { routes.push(url) },
    pageScrollTo() {},
    showToast() {},
    stopPullDownRefresh() { refreshStops++ },
  }
  const tap = dataset => ({currentTarget: {dataset}})
  const report = mountPage('finance', api, wx)
  const orderFromReport = async id => {
    report.openOrder(tap({id}))
    const route = new URL(routes.at(-1), 'https://example.com')
    assert.equal(route.pathname, '/pages/order/index')
    const detail = mountPage('order', api, wx)
    detail.onLoad(Object.fromEntries(route.searchParams))
    await detail.onShow()
    return detail
  }

  await report.onShow()
  report.openInsights()
  assert.equal(routes.at(-1), '/pages/insights/index')

  await report.choosePeriod(tap({period: 'month'}))
  await report.chooseDate({detail: {value: '2026-11'}})
  assert.equal(report.data.dateLabel, '2026-11')
  assert.equal(report.data.report.total.orderCount, 2)
  await report.exportReport()
  assert.deepEqual(exports, [['2026-11-01', 'month']])

  report.selectStaff(tap({pendingOnly: true}))
  const pending = report.data.details.find(order => order.status === 'arrived' && order.date === date)
  assert.ok(pending)
  assert.ok(report.data.details.every(order => order.amountPending))
  report.selectStaff(tap({staffId: 'front', pendingOnly: true}))
  assert.equal(report.data.details.length, 1)
  assert.equal(report.data.details[0].id, pending.id)
  const detail = await orderFromReport(pending.id)
  report.onHide()
  assert.equal(detail.data.amountOpen, true)
  assert.equal(detail.data.order.status, 'arrived')
  detail.changeAmount({detail: {value: '900'}})
  await detail.saveAmount()
  assert.equal(detail.data.order.status, 'settled')

  await report.onShow()
  await report.onPullDownRefresh()
  assert.equal(refreshStops, 1)
  assert.equal(report.data.period, 'month')
  assert.equal(report.data.date, '2026-11-01')
  assert.equal(report.data.staffId, 'front')
  assert.equal(report.data.pendingOnly, true)
  assert.equal(report.data.selectedStaff.amountText, '¥900.00')
  assert.equal(report.data.details.length, 0)

  report.onHide()
  actor = 'finance'
  await report.onShow()
  assert.equal(report.data.period, 'day')
  assert.equal(report.data.date, date)
  assert.equal(report.data.staffId, '')
  assert.equal(report.data.pendingOnly, false)
  assert.equal(report.data.canViewInsights, true)
  const booked = report.data.details.find(order => order.status === 'booked')
  const supplement = await orderFromReport(booked.id)
  assert.equal(supplement.data.order.status, 'booked')
  assert.equal(supplement.data.order.canEdit, false)
  assert.equal(supplement.data.order.canSettle, true)
  assert.equal(supplement.data.amountOpen, true)
  supplement.changeAmount({detail: {value: '120'}})
  await supplement.saveAmount()
  assert.equal(supplement.data.order.amount, 120)
  assert.equal(supplement.data.order.canSettle, false)

  report.onHide()
  actor = 'sales1'
  await report.onShow()
  assert.equal(report.data.report, null)
  assert.equal(report.data.details.length, 0)
  assert.equal(report.data.canViewInsights, false)
})

test('月报分批展示明细，待补筛选能找到后续批次的员工订单', async () => {
  const state = seed()
  for (const person of state.staff) person.nameBound = true
  const input = Array.from({length: 22}, (_, i) => '2026-11-' + String(i + 1).padStart(2, '0')).flatMap(date => [
    {date, meal: 'lunch', time: '12:00'}, {date, meal: 'dinner', time: '18:00'},
  ]).map(slot => ({
    ...slot, ownerId: 'sales1', createdDate: slot.date, tableIds: ['101'], guests: 2,
    contact: '陈女士', phone: '13800001234',
  }))
  const orders = execute(state, 'manager', 'import', {orders: input})
  for (const order of orders.slice(0, -1)) execute(state, 'manager', 'settle', {...order, amount: 10})
  const pending = orders.at(-1)
  const report = mountPage('finance', {
    today: () => '2026-11-23',
    call: (action, data) => execute(state, 'manager', action, data),
  }, {pageScrollTo() {}})

  await report.onShow()
  await report.choosePeriod({currentTarget: {dataset: {period: 'month'}}})
  assert.equal(report.data.report.total.orderCount, 44)
  assert.equal(report.data.details.length, 40)
  assert.equal(report.data.hasMoreOrders, true)
  assert.ok(!report.data.details.some(order => order.id === pending.id))

  report.selectStaff({currentTarget: {dataset: {staffId: 'sales1', pendingOnly: true}}})
  assert.equal(report.data.selectedStaff.orderCount, 44)
  assert.deepEqual(Array.from(report.data.details, order => order.id), [pending.id])

  report.selectStaff({currentTarget: {dataset: {}}})
  report.moreOrders()
  assert.equal(report.data.hasMoreOrders, false)
  assert.equal(report.data.details.at(-1).id, pending.id)
})
