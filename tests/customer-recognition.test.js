const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const test = require('node:test')
const { runInNewContext } = require('node:vm')
const {seed} = require('./fixtures/store')
const { execute, today } = require('../miniprogram/lib/domain')
const reception = require('../miniprogram/lib/reception')

const phone = '13800001234'
const otherPhone = '13900005678'
const bookingPage = readFileSync(require.resolve('../miniprogram/pages/booking/index.js'), 'utf8')

function boundStore() {
  const state = seed()
  for (const [id, name] of Object.entries({ front: '林青', manager: '陈晓', sales1: '李华', sales2: '王梅', finance: '张兰' })) {
    execute(state, id, 'bindStaffName', { name })
  }
  return state
}

function createBooking(state, date, fields = {}, actor = 'sales1') {
  return execute(state, actor, 'save', {
    date, meal: 'dinner', time: '18:00', tableIds: ['201'], guests: 4,
    phone, contact: '林女士', ...fields,
  })
}

test('一次多桌到店只计一次，旧订单可累计，第二次到店升级且其他客户经理看不到订单明细', () => {
  const state = boundStore()
  const first = createBooking(state, '2025-06-01', { tableIds: ['201', '202'] })
  const cancelled = createBooking(state, '2025-06-08', { contact: '已取消的姓名' })
  const pending = createBooking(state, '2025-06-09', { contact: '待到店的姓名' }, 'sales2')
  execute(state, 'front', 'cancel', cancelled)
  assert.equal(execute(state, 'front', 'customerLookup', { phone }), null)
  assert.equal(execute(state, 'sales2', 'customer', { phone }).segment, null)

  const arrived = execute(state, 'front', 'arrive', first)
  const settled = execute(state, 'front', 'settle', { ...arrived, amount: 320 })
  execute(state, 'front', 'settle', { ...settled, amount: 420 })
  const legacy = state.orders.find(order => order.id === first.id)
  delete legacy.customerVisit
  legacy.phone = '0086 (138) 0000-1234'
  assert.deepEqual(execute(state, 'sales2', 'customerLookup', { phone: '8613800001234' }), {
    contact: '林女士', visits: 1, segment: { id: 'new', label: '新客' },
  })

  const second = createBooking(state, '2025-06-02', { contact: '林晓' })
  execute(state, 'front', 'arrive', second)
  const restored = JSON.parse(JSON.stringify(state))
  assert.deepEqual(execute(restored, 'sales2', 'customerLookup', { phone: '+86 (138) 0000-1234' }), {
    contact: '林晓', visits: 2, segment: { id: 'potential', label: '可发展客' },
  })
  const history = execute(restored, 'sales2', 'customer', { phone })
  assert.equal(history.visits, 2)
  assert.deepEqual(history.segment, { id: 'potential', label: '可发展客' })
  assert.deepEqual(history.orders.map(order => order.id), [pending.id])
  const masked = execute(restored, 'sales2', 'order', { id: first.id })
  assert.equal(masked.phone, '138****1234')
  assert.equal(execute(restored, 'front', 'order', { id: first.id }).phone, phone)
  assert.throws(() => execute(restored, 'finance', 'customerLookup', { phone }), { code: 'FORBIDDEN' })
})

test('散客补录号码后可查档，修改联系电话和撤销到店按原来访处理', () => {
  const state = boundStore()
  const walkin = execute(state, 'front', 'save', { kind: 'walkin', tableIds: ['101'], guests: 2 })
  const named = execute(state, 'front', 'save', { id: walkin.id, version: walkin.version, contact: '陈先生', phone })
  assert.equal(execute(state, 'manager', 'customerLookup', { phone }).contact, '陈先生')
  const edited = execute(state, 'front', 'save', {
    id: named.id, version: named.version, contact: '不同联系人', phone: otherPhone,
  })
  assert.deepEqual(execute(state, 'sales1', 'customerLookup', { phone }), {
    contact: '陈先生', visits: 1, segment: { id: 'new', label: '新客' },
  })
  assert.equal(execute(state, 'sales1', 'customerLookup', { phone: otherPhone }), null)
  assert.equal(edited.phone, otherPhone)
  assert.equal(Object.hasOwn(edited, 'customerVisit'), false)
  const masked = execute(state, 'sales1', 'order', { id: walkin.id })
  assert.equal(JSON.stringify(masked).includes(phone), false)
  execute(state, 'front', 'cancel', edited)
  assert.equal(execute(state, 'manager', 'customerLookup', { phone }), null)
})

test('客户档案合计实际到店、最终消费以及各营销的有效预订，历史归属按员工账号保留', () => {
  const state = boundStore()
  const first = createBooking(state, '2025-06-01', {
    tableIds: ['201', '202'], contact: '林女士', deposit: 70, depositMethod: '微信',
  })
  const settled = execute(state, 'front', 'settle', { ...first, amount: '0.10' })
  const legacy = state.orders.find(order => order.id === settled.id)
  legacy.phone = '0086 (138) 0000-1234'
  delete legacy.customerVisit
  delete legacy.ownerRole

  const arrived = execute(state, 'front', 'arrive', createBooking(state, '2025-06-02', { contact: '林晓' }))
  execute(state, 'front', 'save', { id: arrived.id, version: arrived.version, phone: otherPhone, contact: '改后联系人' })
  const walkin = execute(state, 'front', 'save', { kind: 'walkin', tableIds: ['101'], guests: 2, phone }, new Date('2025-06-03T10:00:00Z'))
  execute(state, 'front', 'settle', { ...walkin, amount: '0.20' })
  createBooking(state, '2025-06-04', { contact: '林小姐' }, 'sales2')
  createBooking(state, '2025-06-05', { phone: otherPhone, contact: '赵女士' }, 'sales2')
  const cancelled = execute(state, 'front', 'arrive', createBooking(state, '2025-06-06', { contact: '取消别名' }, 'sales2'))
  execute(state, 'front', 'cancel', cancelled)
  createBooking(state, '2025-06-07', { contact: '店长代订' }, 'front')
  execute(state, 'front', 'cancel', createBooking(state, '2025-06-08', { phone: '13700008888' }))

  execute(state, 'manager', 'setStaffRole', { id: 'sales1', expectedRole: 'sales', role: 'manager' })
  execute(state, 'manager', 'setStaffRole', { id: 'front', expectedRole: 'manager', role: 'sales' })
  execute(state, 'manager', 'setStaffProfile', { id: 'sales1', expectedName: '李华', expectedServicePhone: '', name: '李新', servicePhone: '' })

  const profile = {
    phone, contact: '林晓', visits: 3, amount: 0.3, pending: 1, segment: { id: 'potential', label: '可发展客' },
    salesBookings: [{ staffId: 'sales1', name: '李新', count: 2 }, { staffId: 'sales2', name: '王梅', count: 1 }],
  }
  const pending = {
    phone: otherPhone, contact: '赵女士', visits: 0, amount: 0, pending: 0, segment: null,
    salesBookings: [{ staffId: 'sales2', name: '王梅', count: 1 }],
  }
  assert.deepEqual(execute(state, 'sales1', 'customerDirectory').customers, [profile, pending])
  for (const query of ['林女', '林小姐', '+86 (138) 0000-1234', '1234']) {
    assert.deepEqual(execute(state, 'manager', 'customerDirectory', { query }).customers, [profile])
  }
  for (const query of ['取消别名', '改后联系人', '13700008888']) {
    assert.deepEqual(execute(state, 'manager', 'customerDirectory', { query }).customers, [])
  }
  assert.equal(Object.hasOwn(settled, 'ownerRole'), false)
})

test('客户档案跨页保留搜索范围且不会重复同一个顾客', () => {
  const state = boundStore()
  for (let i = 1; i <= 28; i++) {
    const day = String(i).padStart(2, '0')
    createBooking(state, `2025-07-${day}`, { phone: `138000001${day}`, contact: i === 27 ? '其他客人' : '陈先生' })
  }
  const query = '陈'
  const first = execute(state, 'manager', 'customerDirectory', { query })
  assert.equal(first.customers.length, 25)
  assert.ok(first.next)
  const rest = execute(state, 'manager', 'customerDirectory', { query, afterPhone: first.next })
  assert.deepEqual(rest.customers.map(profile => profile.phone), ['13800000126', '13800000128'])
  assert.equal(rest.next, '')
  assert.equal(new Set([...first.customers, ...rest.customers].map(profile => profile.phone)).size, 27)
})

test('每周按周末的累计到店次数分档，兼容历史号码并保留登记到店时的日期和号码', () => {
  const state = boundStore()
  const cutoff = '2025-02-04'
  const instant = new Date('2025-02-07T00:00:00Z')
  const fourth = createBooking(state, '2025-01-21')
  const last = createBooking(state, cutoff, { phone: otherPhone })

  const first = execute(state, 'front', 'arrive', createBooking(state, '2025-01-07'))
  const legacy = state.orders.find(order => order.id === first.id)
  delete legacy.customerVisit
  legacy.phone = '0086 (138) 0000-1234'
  execute(state, 'front', 'settle', { ...createBooking(state, '2025-01-14', { tableIds: ['201', '202'] }), amount: 100 })
  const third = execute(state, 'front', 'arrive', createBooking(state, '2025-01-15'))
  execute(state, 'front', 'save', { id: third.id, version: third.version, date: '2025-01-22', phone: otherPhone })
  assert.deepEqual(execute(state, 'manager', 'customerLookup', { phone }).segment, { id: 'potential', label: '可发展客' })
  execute(state, 'front', 'arrive', fourth)
  assert.deepEqual(execute(state, 'manager', 'customerLookup', { phone }), {
    contact: '林女士', visits: 4, segment: { id: 'vvip', label: 'VVIP' },
  })

  execute(state, 'front', 'arrive', createBooking(state, '2025-01-08', { phone: otherPhone }))
  execute(state, 'front', 'arrive', last)
  execute(state, 'front', 'arrive', createBooking(state, '2025-02-05', { phone: otherPhone }))
  execute(state, 'front', 'arrive', createBooking(state, '2025-02-06', { phone: otherPhone }))

  const thirdPhone = '13700008888'
  execute(state, 'front', 'arrive', createBooking(state, '2025-01-01', { phone: thirdPhone }))
  createBooking(state, '2025-01-23', { phone: thirdPhone })
  const cancelled = execute(state, 'front', 'arrive', createBooking(state, '2025-01-24', { phone: thirdPhone }))
  execute(state, 'front', 'cancel', cancelled)
  execute(state, 'front', 'save', { kind: 'walkin', tableIds: ['101'], guests: 2 }, new Date('2025-01-25T10:00:00Z'))

  const expected = {
    endDate: cutoff,
    weeks: 4,
    summary: { new: 1, potential: 1, vvip: 1 },
    buckets: [
      { startDate: '2025-01-08', endDate: '2025-01-14', new: 1, potential: 1, vvip: 0 },
      { startDate: '2025-01-15', endDate: '2025-01-21', new: 0, potential: 0, vvip: 1 },
      { startDate: '2025-01-22', endDate: '2025-01-28', new: 0, potential: 0, vvip: 0 },
      { startDate: '2025-01-29', endDate: '2025-02-04', new: 0, potential: 1, vvip: 0 },
    ],
  }
  assert.deepEqual(execute(state, 'manager', 'customerInsights', { endDate: cutoff, weeks: 4 }, instant), expected)
})

test('客群统计使用上海日期，仅供店长和财务查询最近 4 周或 8 周', () => {
  const state = boundStore()
  const instant = new Date('2025-01-01T16:30:00Z')
  const fourWeeks = execute(state, 'finance', 'customerInsights', {}, instant)
  assert.equal(fourWeeks.endDate, '2025-01-02')
  assert.equal(fourWeeks.weeks, 4)
  assert.equal(fourWeeks.buckets.length, 4)
  assert.deepEqual(fourWeeks.summary, { new: 0, potential: 0, vvip: 0 })
  assert.deepEqual(fourWeeks.buckets.at(-1), {
    startDate: '2024-12-27', endDate: '2025-01-02', new: 0, potential: 0, vvip: 0,
  })

  const eightWeeks = execute(state, 'manager', 'customerInsights', { weeks: 8 }, instant)
  assert.equal(eightWeeks.weeks, 8)
  assert.equal(eightWeeks.buckets.length, 8)
  assert.deepEqual(eightWeeks.buckets[0], {
    startDate: '2024-11-08', endDate: '2024-11-14', new: 0, potential: 0, vvip: 0,
  })

  for (const id of ['sales1', 'sales2']) {
    assert.throws(() => execute(state, id, 'customerInsights', {}, instant), { code: 'FORBIDDEN' })
  }
  for (const data of [{ endDate: '2025-01-03' }, { endDate: '2024-02-30' }, { weeks: 6 }, { weeks: '4' }]) {
    assert.throws(() => execute(state, 'manager', 'customerInsights', data, instant), { code: 'VALIDATION' })
  }
})

function reservationPage() {
  const lookups = new Map()
  const saves = []
  let page
  runInNewContext(bookingPage, {
    Page(definition) { page = definition },
    require(name) {
      if (name.endsWith('/reception')) return reception
      return {
        today,
        call(action, data) {
          if (action === 'save') {
            saves.push(data)
            return Promise.resolve({ id: 'saved' })
          }
          assert.equal(action, 'customerLookup')
          assert.equal(lookups.has(data.phone), false)
          const lookup = Promise.withResolvers()
          lookups.set(data.phone, lookup)
          return lookup.promise
        },
      }
    },
    setTimeout,
    clearTimeout,
  })
  page.setData = function (values) {
    for (const [path, value] of Object.entries(values)) {
      const [name, field] = path.split('.')
      if (field) this.data[name][field] = value
      else this.data[name] = value
    }
  }
  page.setData({ contextLoading: false, boardLoading: false })
  page.finish = () => {}
  return { page, lookups, saves }
}

function input(value, field) {
  return { detail: { value }, currentTarget: { dataset: { field } } }
}

test('订餐表不会用较早的手机号结果或查档结果覆盖手填姓名', async () => {
  const { page, lookups } = reservationPage()
  page.changePhone(input(phone))
  const first = page.lookupCustomer()
  page.changePhone(input(otherPhone))
  const second = page.lookupCustomer()
  lookups.get(otherPhone).resolve({ contact: '吴女士', visits: 1, segment: { id: 'new', label: '新客' } })
  await second
  lookups.get(phone).resolve({ contact: '赵先生', visits: 2, segment: { id: 'potential', label: '可发展客' } })
  await first
  assert.equal(page.data.form.contact, '吴女士')
  assert.equal(page.data.customer.visits, 1)

  const lastPhone = '13700008888'
  page.changePhone(input(lastPhone))
  assert.equal(page.data.form.contact, '')
  const last = page.lookupCustomer()
  page.changeField(input('手填姓名', 'contact'))
  lookups.get(lastPhone).resolve({ contact: '历史姓名', visits: 2, segment: { id: 'potential', label: '可发展客' } })
  await last
  assert.equal(page.data.form.contact, '手填姓名')
  assert.equal(page.data.customer.segment.label, '可发展客')
})

test('填写手机号后立即确认预订会等候档案返回，并将识别到的姓名写入订单', async () => {
  const { page, lookups, saves } = reservationPage()
  page.setData({
    'form.date': today(), 'form.time': '18:00', 'form.guests': '4', 'form.tableIds': ['201'],
  })
  page.changePhone(input(phone))
  const lookup = page.lookupCustomer()
  const saving = page.save()
  assert.equal(saves.length, 0)
  lookups.get(phone).resolve({ contact: '林女士', visits: 2, segment: { id: 'potential', label: '可发展客' } })
  await Promise.all([lookup, saving])
  assert.equal(saves.length, 1)
  assert.equal(saves[0].phone, phone)
  assert.equal(saves[0].contact, '林女士')
})
