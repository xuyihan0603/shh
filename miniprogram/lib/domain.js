const { segmentForVisits } = require('./customer-segments')
const { shiftDate } = require('./reception')

const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000
const MEALS = ['lunch', 'dinner']
// Existing orders and login records refer to the original administrator ID.
const ADMIN_ID = 'manager'
const STAFF_ROLES = ['sales', 'finance', 'manager']
const ROLES = [...STAFF_ROLES, 'admin']
const WECHAT_STAFF_ROLES = [...STAFF_ROLES, 'pending']
const STAFF_ROLE_NAMES = ['营销', '财务', '店长', '管理员', '前台', '客户经理', '销售', '员工', '待分配']

function shanghaiClock(instant) {
  return new Date(instant.getTime() + SHANGHAI_OFFSET).toISOString()
}

function today(instant = new Date()) {
  return shanghaiClock(instant).slice(0, 10)
}

function seed() {
  return {
    ...require('./pilot').pilotLayout(),
    staff: [{ id: ADMIN_ID, name: '管理员', role: 'admin', active: true, nameBound: false }],
    orders: [],
    nextOrderNumber: 1,
  }
}

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code }, details)
}

function readObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('VALIDATION', `请填写${label}`)
  }
  return value
}

function readText(value, label, required = false) {
  if (value == null) value = ''
  if (typeof value !== 'string') fail('VALIDATION', `${label}格式不正确`)
  const trimmed = value.trim()
  if (required && !trimmed) fail('VALIDATION', `请填写${label}`)
  return trimmed
}

function readDate(value, label = '用餐日期') {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`)
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return value
  }
  fail('VALIDATION', `${label}不正确`)
}

function readMeal(value) {
  if (!MEALS.includes(value)) fail('VALIDATION', '请选择午餐或晚餐')
  return value
}

function readTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    fail('VALIDATION', '请选择正确的到店时间')
  }
  return value
}

function readPositiveInteger(value, label) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value)
  if (!Number.isSafeInteger(value) || value < 1) fail('VALIDATION', `${label}必须是正整数`)
  return value
}

function readMoney(value, label) {
  const number = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : ''
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(number)) {
    fail('VALIDATION', `${label}请填写非负金额，最多两位小数`)
  }
  const [yuan, jiaoFen = ''] = number.split('.')
  const cents = Number(yuan) * 100 + Number(jiaoFen.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || Math.round(cents / 100 * 100) !== cents) {
    fail('VALIDATION', `${label}超出可登记范围`)
  }
  return cents / 100
}

function normalizePhone(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/[\s()-]/g, '')
    .replace(/^\+86(?=\d{11}$)|^(?:00)?86(?=1[3-9]\d{9}$)/, '').replace(/^\+/, '')
  return /^\d{7,15}$/.test(normalized) ? normalized : ''
}

function readPhone(value, required = false) {
  const phone = readText(value, '联系电话', required)
  if (!phone) return ''
  const normalized = normalizePhone(phone)
  if (!normalized) fail('VALIDATION', '请输入正确的联系电话')
  return normalized
}

function normalizeServicePhone(value) {
  if (typeof value !== 'string') return ''
  const phone = value.replace(/[\s()-]/g, '')
  const match = /^(?:(?:\+|00)?86)?(1[3-9]\d{9})$/.exec(phone)
  return match ? match[1] : ''
}

function readServicePhone(value, required = false) {
  if (typeof value !== 'string') fail('VALIDATION', '服务手机号格式不正确')
  const phone = readText(value, '服务手机号', required)
  if (!phone) return ''
  const normalized = normalizeServicePhone(phone)
  if (!normalized) fail('VALIDATION', '请输入正确的中国大陆服务手机号')
  return normalized
}

function maskPhone(phone) {
  if (!phone) return ''
  const middle = Math.floor((phone.length - 4) / 2)
  return `${phone.slice(0, middle)}****${phone.slice(middle + 4)}`
}

function handlesStoreOrders(actor) {
  return actor.role === 'manager' || actor.role === 'admin'
}

function ownsOrder(actor, order) {
  return actor.role === 'sales' && actor.id === order.ownerId
}

function managesOrder(actor, order) {
  return handlesStoreOrders(actor) || ownsOrder(actor, order)
}

function permissions(actor, order) {
  const reception = handlesStoreOrders(actor)
  const open = order.status === 'booked' || order.status === 'arrived'
  const editable = open && managesOrder(actor, order)
  return {
    canEdit: editable,
    canCancel: editable,
    canArrive: reception && order.status === 'booked',
    canSettle: order.status !== 'cancelled' && (reception || (actor.role === 'finance' && order.amount === null)),
  }
}

function showOrder(actor, order) {
  const authorized = managesOrder(actor, order)
  const phone = normalizePhone(order.phone)
  const { customerVisit, ownerServicePhone, ...orderFields } = order
  return {
    ...orderFields,
    phone: authorized ? (phone || order.phone) : maskPhone(phone),
    tableIds: order.tableIds.slice(),
    tableNames: order.tableNames.slice(),
    logs: authorized || actor.role === 'finance' ? order.logs.map(log => ({ ...log })) : [],
    ...permissions(actor, order),
  }
}

function profile({ id, name, role, nameBound }) {
  return { id, name, role, nameBound: nameBound === true }
}

function accountProfile(actor) {
  const servicePhone = normalizeServicePhone(actor.servicePhone)
  return { ...profile(actor), ...(servicePhone ? { servicePhone } : {}) }
}

function requireStaffName(actor) {
  if (actor.nameBound !== true) fail('NAME_REQUIRED', '请到「我的」填写员工姓名')
}

function requireAdmin(actor) {
  requireStaffName(actor)
  if (actor.role !== 'admin') fail('FORBIDDEN', '仅管理员可维护员工账号')
}

function isStaffId(id) {
  return typeof id === 'string' && /^[\w-]{1,40}$/.test(id) &&
    !['walkin', '__proto__', 'constructor', 'prototype'].includes(id)
}

function staffRoleProfile(person) {
  return { ...profile(person), active: person.active !== false }
}

function manageStaffRoles(state, actor, action, data) {
  requireAdmin(actor)
  if (action === 'staffRoles') return state.staff.map(staffRoleProfile)

  const { id, role, expectedRole } = data
  const choices = state.environment === 'wechat-test' ? WECHAT_STAFF_ROLES : STAFF_ROLES
  if (!isStaffId(id) || !choices.includes(role) || !choices.includes(expectedRole)) {
    fail('VALIDATION', '员工职位资料有误')
  }
  if (id === actor.id) fail('VALIDATION', '管理员不能修改自己的职位')
  const person = state.staff.find(staff => staff.id === id)
  if (!person) fail('NOT_FOUND', '未找到该员工账号')
  if (person.role !== expectedRole) fail('VERSION_CONFLICT', '员工职位已变更，请刷新后重试')

  person.role = role
  return staffRoleProfile(person)
}

function isStaffRoleName(name) {
  const lower = name.toLowerCase()
  return STAFF_ROLE_NAMES.includes(name) || ROLES.includes(lower) || ['front', 'pending'].includes(lower)
}

function suggestStaffName(actor) {
  const name = (actor.name || '').trim()
  if (isStaffRoleName(name) || name.toLowerCase() === actor.id.toLowerCase() || ['小李', '小周'].includes(name)) return ''
  return name
}

function bindStaffName(actor, data) {
  const name = readText(data.name, '员工姓名', true)
  if (name.length > 40 || /[\x00-\x1F\x7F-\x9F]/.test(name)) fail('VALIDATION', '员工姓名格式不正确')
  if (isStaffRoleName(name)) fail('VALIDATION', '请填写本人姓名')
  if (actor.nameBound === true && actor.name !== name) fail('FORBIDDEN', '姓名已绑定，请联系管理员修改')
  if (data.servicePhone !== undefined) {
    actor.servicePhone = readServicePhone(data.servicePhone, actor.nameBound !== true && actor.role !== 'finance')
  }
  actor.name = name
  actor.nameBound = true
  return accountProfile(actor)
}

function findOrder(state, id) {
  const order = state.orders.find(item => item.id === id)
  if (!order) fail('NOT_FOUND', '未找到这笔订单')
  return order
}

function notificationContext(state, actor, data) {
  const order = findOrder(state, data.id)
  if (!managesOrder(actor, order)) fail('FORBIDDEN', '无权发送此订单的通知')
  if (data.version !== undefined && order.version !== data.version) fail('VERSION_CONFLICT', '订单已更新，请重新核对预订和接收号码')
  if (order.kind !== 'booking' || order.status !== 'booked') fail('GONE', '仅待到店的预订可发送通知')
  const owner = state.staff.find(person => person.id === order.ownerId)
  return {
    order: { ...order, phone: normalizePhone(order.phone) || order.phone },
    store: state.store,
    tables: state.tables,
    owner: owner && { id: owner.id, name: owner.name, servicePhone: owner.servicePhone },
  }
}

function mutationTarget(state, actor, data, permission) {
  const order = findOrder(state, data.id)
  const canManage = permission === 'canEdit' || permission === 'canCancel'
    ? managesOrder(actor, order)
    : handlesStoreOrders(actor) || (permission === 'canSettle' && actor.role === 'finance')
  if (!canManage) fail('FORBIDDEN', '当前岗位无权操作这笔订单')
  if (order.version !== data.version) fail('VERSION_CONFLICT', '订单已更新，请刷新后再操作')
  if (!permissions(actor, order)[permission]) fail('VALIDATION', '当前订单状态不能执行此操作')
  return order
}

function compareServiceTime(first, second) {
  return first.date.localeCompare(second.date) || first.time.localeCompare(second.time)
}

function forBoard(state, data) {
  const date = readDate(data.date === undefined ? today() : data.date)
  const meal = readMeal(data.meal)
  const occupied = new Map()
  let guestCount = 0
  for (const order of state.orders) {
    if (order.date !== date || order.meal !== meal || order.status === 'cancelled') continue
    guestCount += order.guests
    const occupancy = { orderId: order.id, orderStatus: order.status }
    if (order.status === 'booked') {
      const originalName = typeof order.ownerName === 'string' ? order.ownerName.trim() : ''
      const ownerName = originalName || state.staff.find(staff => staff.id === order.ownerId)?.name
      if (ownerName) occupancy.ownerName = ownerName
    }
    for (const id of order.tableIds) occupied.set(id, occupancy)
  }
  return {
    date,
    meal,
    guestCount,
    tables: state.tables.map(table => ({
      ...table,
      ...(occupied.get(table.id) || { orderId: null, orderStatus: null }),
    })),
  }
}

function matchingPhone(state, actor, phone) {
  if (actor.role === 'finance') fail('FORBIDDEN', '当前岗位不能按电话查询订单')
  return state.orders.filter(order =>
    (handlesStoreOrders(actor) || ownsOrder(actor, order)) && normalizePhone(order.phone) === phone)
}

function listOrders(state, actor, data) {
  const date = data.date == null || data.date === '' ? '' : readDate(data.date)
  const meal = data.meal == null || data.meal === '' ? '' : readMeal(data.meal)
  const phone = readPhone(data.phone)
  const source = phone ? matchingPhone(state, actor, phone) : state.orders
  return source.filter(order => (!date || order.date === date) && (!meal || order.meal === meal))
    .sort((first, second) => second.date.localeCompare(first.date) || first.time.localeCompare(second.time))
    .map(order => showOrder(actor, order))
}

function listStoreOrders(state, actor, data) {
  if (!handlesStoreOrders(actor)) fail('FORBIDDEN', '仅店长和管理员可查看跨日期的全店订单')
  const meal = data.meal ? readMeal(data.meal) : ''
  const end = data.beforeId ? state.orders.findIndex(order => order.id === data.beforeId) : state.orders.length
  if (end < 0) fail('VALIDATION', '订单列表已更新，请重新加载')
  const orders = []
  let total = 0
  let next = ''
  for (let i = state.orders.length - 1; i >= 0; i--) {
    const order = state.orders[i]
    if (meal && order.meal !== meal) continue
    total++
    if (i >= end) continue
    if (orders.length === 25) {
      next = orders[24].id
      continue
    }
    const { id, date, time, kind, status, tableNames, guests, contact, ownerName, phone, deposit } = order
    orders.push({ id, date, time, meal: order.meal, kind, status, tableNames: [...tableNames], guests,
      contact, ownerName, phone: normalizePhone(phone) || phone || '', deposit })
  }
  return { orders, total, next }
}

function hasVisited(order) {
  return order.status === 'arrived' || order.status === 'settled'
}

function visitFor(order) {
  const contact = typeof order.contact === 'string' ? order.contact.trim() : ''
  return order.customerVisit || {
    date: order.date, time: order.time, phone: normalizePhone(order.phone), contact,
  }
}

function customerForPhone(state, phone) {
  let visits = 0
  let latestNamedVisit = null
  for (const order of state.orders) {
    if (!hasVisited(order)) continue
    const visit = visitFor(order)
    if (normalizePhone(visit.phone) !== phone) continue
    visits++
    if (visit.contact && (!latestNamedVisit || compareServiceTime(visit, latestNamedVisit) >= 0)) {
      latestNamedVisit = visit
    }
  }
  if (!visits) return null
  const { id, label } = segmentForVisits(visits)
  return {
    contact: latestNamedVisit ? latestNamedVisit.contact : '',
    visits,
    segment: { id, label },
  }
}

function lookupCustomer(state, actor, data) {
  if (!handlesStoreOrders(actor) && actor.role !== 'sales') fail('FORBIDDEN', '当前岗位不能查询客人档案')
  return customerForPhone(state, readPhone(data.phone, true))
}

function findCustomer(state, actor, data) {
  const phone = readPhone(data.phone, true)
  const orders = matchingPhone(state, actor, phone).sort((first, second) => compareServiceTime(second, first))
  const customer = customerForPhone(state, phone)
  if (!customer && !orders.length) return null
  return {
    ...(customer || { contact: '', visits: 0, segment: null }),
    phone,
    orders: orders.map(order => showOrder(actor, order)),
  }
}

function emptyCustomerCounts() {
  return { new: 0, potential: 0, vvip: 0 }
}

function forCustomerInsights(state, actor, data, instant) {
  if (!handlesStoreOrders(actor) && actor.role !== 'finance') fail('FORBIDDEN', '仅财务、店长和管理员可查看客群分析')
  const currentDate = today(instant)
  const endDate = data.endDate === undefined ? currentDate : readDate(data.endDate, '统计截止日期')
  if (endDate > currentDate) fail('VALIDATION', '统计截止日期不能晚于今天')
  const weeks = data.weeks === undefined ? 4 : data.weeks
  if (weeks !== 4 && weeks !== 8) fail('VALIDATION', '请选择最近 4 周或 8 周')

  const ranges = Array.from({ length: weeks }, (_, index) => {
    const lastDate = shiftDate(endDate, (index + 1 - weeks) * 7)
    return { startDate: shiftDate(lastDate, -6), endDate: lastDate, visits: new Map() }
  })
  const cumulativeVisits = new Map()
  for (const order of state.orders) {
    if (!hasVisited(order)) continue
    const visit = visitFor(order)
    const phone = normalizePhone(visit.phone)
    if (!phone || !visit.date || visit.date > endDate) continue
    const range = ranges.find(({ startDate, endDate }) => visit.date >= startDate && visit.date <= endDate)
    // Earlier visits contribute to the customer's segment without appearing in a weekly count.
    const visits = range ? range.visits : cumulativeVisits
    visits.set(phone, (visits.get(phone) || 0) + 1)
  }

  const buckets = ranges.map(({ startDate, endDate, visits }) => {
    const counts = emptyCustomerCounts()
    for (const [phone, count] of visits) {
      const total = (cumulativeVisits.get(phone) || 0) + count
      cumulativeVisits.set(phone, total)
      counts[segmentForVisits(total).id]++
    }
    return { startDate, endDate, ...counts }
  })
  const summary = emptyCustomerCounts()
  for (const count of cumulativeVisits.values()) summary[segmentForVisits(count).id]++
  return { endDate, weeks, summary, buckets }
}

function resolveTables(state, tableIds) {
  if (!Array.isArray(tableIds) || !tableIds.length) fail('VALIDATION', '请至少选择一张桌')
  if (new Set(tableIds).size !== tableIds.length) fail('VALIDATION', '请勿重复选桌')
  return tableIds.map(id => {
    const table = state.tables.find(item => item.id === id)
    if (!table) fail('VALIDATION', '所选桌位已变更，请刷新后重新选桌')
    return table
  })
}

function checkTables(state, current, date, meal, tables) {
  const occupied = new Set()
  for (const order of state.orders) {
    if (order === current || order.date !== date || order.meal !== meal || order.status === 'cancelled') continue
    for (const id of order.tableIds) occupied.add(id)
  }
  const conflicts = tables.filter(table => occupied.has(table.id))
  if (conflicts.length) {
    const names = conflicts.map(table => table.name).join('、')
    fail('TABLE_CONFLICT', `${names}已被预订，请重新选桌`, { tableIds: conflicts.map(table => table.id) })
  }
}

function audit(actor, instant, action) {
  return { at: instant.toISOString(), actorId: actor.id, actorName: actor.name, action }
}

function depositDescription(order) {
  if (!order.deposit) return '未收订金'
  return `${order.deposit} 元，${order.depositMethod}，经手人 ${order.depositHandler}`
}

function describeChanges(current, updated) {
  const actions = []
  if (updated.tableIds.length !== current.tableIds.length ||
      updated.tableIds.some(id => !current.tableIds.includes(id))) {
    actions.push(`换桌（${current.tableNames.join('、')} → ${updated.tableNames.join('、')}）`)
  }
  if (['date', 'meal', 'time', 'guests', 'contact', 'phone', 'notes'].some(field => current[field] !== updated[field])) {
    actions.push('修改订单信息')
  }
  if (['deposit', 'depositMethod', 'depositHandler'].some(field => current[field] !== updated[field])) {
    actions.push(`修改订金（${depositDescription(current)} → ${depositDescription(updated)}）`)
  }
  return actions
}

function saveOrder(state, actor, data, instant, importing = false) {
  const creating = data.id == null || data.id === ''
  const current = creating ? null : mutationTarget(state, actor, data, 'canEdit')
  if (creating && !handlesStoreOrders(actor) && actor.role !== 'sales') {
    fail('FORBIDDEN', '当前岗位不能登记订单')
  }
  const originalAssignment = data.ownerId !== undefined || data.createdDate !== undefined
  if (data.ownerName !== undefined || data.ownerServicePhone !== undefined) fail('FORBIDDEN', '预订员工姓名和服务手机号由系统根据员工账号记录')
  if (originalAssignment && !importing) {
    fail('FORBIDDEN', '仅录入存量预订时可以指定原接单人和接单日')
  }
  const value = (field, fallback) => data[field] !== undefined ? data[field] : current ? current[field] : fallback
  const kind = value('kind', 'booking')
  if (kind !== 'booking' && kind !== 'walkin') fail('VALIDATION', '请选择预订或散客')
  if (current && current.kind !== kind) fail('VALIDATION', '建单后不能修改订单类型')
  if (kind === 'walkin' && !handlesStoreOrders(actor)) fail('FORBIDDEN', '仅店长和管理员可以登记散客')

  const clock = shanghaiClock(instant)
  const currentDate = clock.slice(0, 10)
  const currentTime = clock.slice(11, 16)
  const date = readDate(value('date', kind === 'walkin' ? currentDate : undefined))
  if (kind === 'walkin' && date !== currentDate && (!current || date !== current.date)) {
    fail('VALIDATION', '散客只能登记在当天')
  }
  const meal = readMeal(value('meal', kind === 'walkin' ? (currentTime < '15:00' ? 'lunch' : 'dinner') : undefined))
  const time = readTime(value('time', '') || (kind === 'walkin' ? currentTime : ''))
  const tables = resolveTables(state, value('tableIds'))
  const guests = readPositiveInteger(value('guests'), '用餐人数')
  const contact = readText(value('contact'), '联系人', kind === 'booking')
  const phone = readPhone(value('phone'), kind === 'booking')
  const notes = readText(value('notes'), '备注')
  const rawDeposit = value('deposit', 0)
  const deposit = rawDeposit == null || rawDeposit === '' ? 0 : readMoney(rawDeposit, '订金')
  const depositMethod = deposit ? readText(value('depositMethod'), '收款方式', true) : ''
  const retainHandler = current && current.deposit === deposit && current.depositMethod === depositMethod
  const depositHandler = deposit ? (readText(data.depositHandler, '订金经手人') ||
    (retainHandler && current.depositHandler) || actor.name) : ''

  const owner = data.ownerId === undefined ? actor : state.staff.find(staff => staff.id === data.ownerId)
  if (!owner || (!handlesStoreOrders(owner) && owner.role !== 'sales')) fail('VALIDATION', '原接单人需要是营销、店长或管理员')
  const createdDate = data.createdDate === undefined ? currentDate : readDate(data.createdDate, '接单日期')
  if (originalAssignment && (createdDate > currentDate || createdDate > date)) {
    fail('VALIDATION', '接单日期不能晚于今天或用餐日期')
  }
  checkTables(state, current, date, meal, tables)

  const fields = {
    date, meal, time, guests, contact, phone, notes, kind, deposit, depositMethod, depositHandler,
    tableIds: tables.map(table => table.id),
    tableNames: tables.map(table => table.name),
  }
  if (current) {
    const updated = { ...current, ...fields }
    const actions = describeChanges(current, updated)
    if (!actions.length) return showOrder(actor, current)
    if (hasVisited(current)) {
      // Keep the number recorded at check-in when the order's contact number changes.
      const visit = visitFor(current)
      updated.customerVisit = !visit.phone || visit.phone === updated.phone
        ? { ...visit, phone: updated.phone, contact: updated.contact }
        : visit
    }
    updated.logs = current.logs.concat(actions.map(action => audit(actor, instant, action)))
    updated.version++
    state.orders[state.orders.indexOf(current)] = updated
    return showOrder(actor, updated)
  }

  const action = importing ? '录入存量预订' : kind === 'walkin' ? '登记散客' : '创建预订'
  const logs = [audit(actor, instant, action)]
  if (deposit) logs.push(audit(actor, instant, `登记订金（${depositDescription(fields)}）`))
  const ownerServicePhone = kind === 'booking' ? normalizeServicePhone(owner.servicePhone) : ''
  const order = {
    ...fields,
    id: `order-${state.nextOrderNumber}`,
    version: 1,
    ownerId: owner.id,
    ownerName: owner.name,
    ...(ownerServicePhone ? { ownerServicePhone } : {}),
    createdDate,
    amount: null,
    status: kind === 'walkin' ? 'arrived' : 'booked',
    logs,
  }
  if (hasVisited(order)) order.customerVisit = visitFor(order)
  state.orders.push(order)
  state.nextOrderNumber++
  return showOrder(actor, order)
}

function changeStatus(state, actor, action, data, instant) {
  const permission = { arrive: 'canArrive', cancel: 'canCancel', settle: 'canSettle' }[action]
  const current = mutationTarget(state, actor, data, permission)

  const status = { arrive: 'arrived', cancel: 'cancelled', settle: 'settled' }[action]
  let amount = current.amount
  let description = action === 'cancel' ? '取消订单' : '登记到店'
  if (action === 'settle') {
    amount = readMoney(data.amount, '最终消费额')
    if (current.status === 'settled' && amount === current.amount) return showOrder(actor, current)
    description = current.amount === null
      ? `录入最终消费额（${amount} 元）`
      : `修改最终消费额（${current.amount} 元 → ${amount} 元）`
  }
  const updated = {
    ...current, status, amount, version: current.version + 1,
    logs: current.logs.concat(audit(actor, instant, description)),
  }
  if (hasVisited(updated)) updated.customerVisit = visitFor(current)
  state.orders[state.orders.indexOf(current)] = updated
  return showOrder(actor, updated)
}

function emptyTotals() {
  return { orderCount: 0, tableCount: 0, amount: 0, pending: 0, deposit: 0 }
}

function addOrder(totals, order) {
  totals.orderCount++
  totals.tableCount += order.tableIds.length
  totals.deposit += Math.round(order.deposit * 100)
  if (order.amount === null) totals.pending++
  else totals.amount += Math.round(order.amount * 100)
}

function inYuan(totals) {
  return { ...totals, amount: totals.amount / 100, deposit: totals.deposit / 100 }
}

function forReport(state, actor, data) {
  if (!handlesStoreOrders(actor) && actor.role !== 'finance') fail('FORBIDDEN', '仅财务、店长和管理员可查看财务报表')
  const date = readDate(data.date === undefined ? today() : data.date, '统计日期')
  const { period = 'day' } = data
  if (period !== 'day' && period !== 'month') fail('VALIDATION', '请选择日报或月报')
  const month = date.slice(0, 7)
  const orders = state.orders.filter(order => period === 'month' ? order.date.slice(0, 7) === month : order.date === date)
    .sort(compareServiceTime)
  const rows = new Map(state.staff.filter(staff => staff.role !== 'finance' && staff.role !== 'pending')
    .map(staff => [staff.id, { staffId: staff.id, name: staff.name, ...emptyTotals() }]))
  rows.set('walkin', { staffId: 'walkin', name: '散客', ...emptyTotals() })
  const total = emptyTotals()
  for (const order of orders) {
    if (order.status === 'cancelled') continue
    const ownerId = order.kind === 'walkin' ? 'walkin' : order.ownerId
    if (!rows.has(ownerId)) rows.set(ownerId, { staffId: ownerId, name: order.ownerName, ...emptyTotals() })
    addOrder(rows.get(ownerId), order)
    addOrder(total, order)
  }
  return {
    date, period, basis: 'meal', rows: Array.from(rows.values(), inYuan), total: inYuan(total),
    details: orders.map(order => showOrder(actor, order)),
  }
}

function readTableCapacity(value, label) {
  const raw = typeof value === 'string' ? value.trim() : value
  return raw == null || raw === '' ? null : readPositiveInteger(raw, label)
}

function configure(state, actor, data) {
  if (actor.role !== 'admin') fail('FORBIDDEN', '仅管理员可以修改门店配置')
  const storeInput = data.store === undefined ? state.store : { ...state.store, ...readObject(data.store, '门店资料') }
  const store = {
    name: readText(storeInput.name, '门店名称', true),
    address: readText(storeInput.address, '门店地址'),
    phone: readText(storeInput.phone, '门店电话'),
  }
  readPhone(store.phone)
  const tableInput = data.tables === undefined ? state.tables : data.tables
  if (!Array.isArray(tableInput)) fail('VALIDATION', '桌位清单格式不正确')
  const previousTables = new Map(state.tables.map(table => [table.id, table]))
  const tableIds = new Set()
  const namesByFloor = new Set()
  const tables = tableInput.map(input => {
    const table = readObject(input, '桌位资料')
    const id = readText(table.id, '桌位编号', true)
    const name = readText(table.name, '桌名', true)
    const floor = readText(table.floor, '楼层', true)
    const capacity = readTableCapacity(table.capacity, '最多人数')
    const previousMinimum = previousTables.get(id)?.minCapacity ?? null
    const retainedMinimum = capacity !== null && previousMinimum <= capacity ? previousMinimum : null
    const minCapacity = table.minCapacity === undefined ? retainedMinimum : readTableCapacity(table.minCapacity, '最少人数')
    if (minCapacity !== null && (capacity === null || minCapacity > capacity)) {
      fail('VALIDATION', '请填写最多人数，且不能少于最少人数')
    }
    if (!['hall', 'room', 'unknown'].includes(table.type)) fail('VALIDATION', '请选择散台、包间或待补充')
    if (tableIds.has(id)) fail('VALIDATION', `桌位编号 ${id} 已存在`)
    const floorAndName = JSON.stringify([floor, name])
    if (namesByFloor.has(floorAndName)) fail('VALIDATION', `${floor}的桌名 ${name} 已存在`)
    tableIds.add(id)
    namesByFloor.add(floorAndName)
    return { id, name, floor, type: table.type, minCapacity, capacity }
  })
  for (const order of state.orders) {
    if (order.tableIds.some(id => !tableIds.has(id))) fail('VALIDATION', '不能删除已有订单记录的桌位')
  }
  state.store = store
  state.tables = tables
  return { store: { ...store }, tables: tables.map(table => ({ ...table })) }
}

function importOrders(state, actor, data, instant) {
  if (!handlesStoreOrders(actor)) fail('FORBIDDEN', '仅店长和管理员可以录入存量预订')
  if (!Array.isArray(data.orders) || !data.orders.length) fail('VALIDATION', '请填写待录入的预订')
  const draft = { ...state, orders: state.orders.slice() }
  const orders = data.orders.map((item, index) => {
    try {
      const order = readObject(item, '预订资料')
      if (order.id || (order.kind && order.kind !== 'booking')) fail('VALIDATION', '仅可新增存量预订')
      return saveOrder(draft, actor, order, instant, true)
    } catch (error) {
      error.row = index + 1
      throw error
    }
  })
  state.orders = draft.orders
  state.nextOrderNumber = draft.nextOrderNumber
  return orders
}

function execute(state, actorId, action, data = {}, instant = new Date()) {
  const actor = state.staff.find(staff => staff.id === actorId)
  const pending = state.environment === 'wechat-test' && actor?.role === 'pending'
  if (!actor || actor.active === false || (!pending && !ROLES.includes(actor.role))) fail('FORBIDDEN', '员工账号无效')
  readObject(data, '操作资料')
  if (action === 'bindStaffName') return bindStaffName(actor, data)
  if (action === 'bootstrap') {
    const me = accountProfile(actor)
    if (pending) return {
      me: { ...me, active: true }, nameSuggestion: '', staff: [], tables: [],
      canBindAdmin: !state.staff.some(staff => staff.id === ADMIN_ID),
    }
    return {
      store: { ...state.store }, me, nameSuggestion: me.nameBound ? '' : suggestStaffName(actor),
      staff: me.nameBound ? state.staff.filter(staff => staff.role !== 'pending').map(profile) : [],
      tables: me.nameBound ? state.tables.map(table => ({ ...table })) : [],
    }
  }
  if (pending && action !== 'setServicePhone') fail('ACCESS_PENDING', '请等待管理员分配员工职位')
  if (action === 'staffRoles' || action === 'setStaffRole') return manageStaffRoles(state, actor, action, data)
  requireStaffName(actor)
  switch (action) {
    case 'setServicePhone':
      actor.servicePhone = readServicePhone(data.servicePhone)
      return accountProfile(actor)
    case 'board': return forBoard(state, data)
    case 'orders': return listOrders(state, actor, data)
    case 'storeOrders': return listStoreOrders(state, actor, data)
    case 'order': return showOrder(actor, findOrder(state, data.id))
    case 'notificationContext': return notificationContext(state, actor, data)
    case 'save': return saveOrder(state, actor, data, instant)
    case 'arrive':
    case 'cancel':
    case 'settle': return changeStatus(state, actor, action, data, instant)
    case 'customer': return findCustomer(state, actor, data)
    case 'customerLookup': return lookupCustomer(state, actor, data)
    case 'customerInsights': return forCustomerInsights(state, actor, data, instant)
    case 'report': return forReport(state, actor, data)
    case 'configure': return configure(state, actor, data)
    case 'import': return importOrders(state, actor, data, instant)
    default: fail('VALIDATION', '不支持这项操作')
  }
}

module.exports = { seed, execute, today, profile, requireStaffName, requireAdmin, isStaffId, ADMIN_ID, ROLES, normalizeServicePhone, readServicePhone }
