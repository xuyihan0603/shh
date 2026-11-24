const MEALS = { lunch: '午餐', dinner: '晚餐' }
const ROLES = { sales: '营销', finance: '财务', manager: '店长', admin: '管理员', pending: '待分配' }
const STATUSES = { booked: '已预订', arrived: '已到店', cancelled: '已取消', settled: '已结账' }
const TABLE_TYPES = { hall: '散台', room: '包间' }
const TYPES = [
  { id: '', label: '全部' },
  { id: 'hall', label: '散台' },
  { id: 'room', label: '包间' },
]

function currentMeal() {
  const shanghai = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return shanghai.getUTCHours() < 15 ? 'lunch' : 'dinner'
}

function shiftDate(value, days) {
  const date = new Date(value + 'T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function dateLabel(value, today) {
  const date = new Date(value + 'T00:00:00Z')
  const weekday = '日一二三四五六'[date.getUTCDay()]
  const monthDay = (date.getUTCMonth() + 1) + '月' + date.getUTCDate() + '日'
  const year = today && value.slice(0, 4) === today.slice(0, 4) ? '' : date.getUTCFullYear() + '年'
  return value === today ? '今天 · ' + monthDay : year + monthDay + ' 周' + weekday
}

function canBook(role) {
  return canManageOrders(role) || role === 'sales'
}

function canManageOrders(role) {
  return role === 'admin' || role === 'manager'
}

function canViewReports(role) {
  return canManageOrders(role) || role === 'finance'
}

function staffCode(id) {
  return id.slice(-8).toUpperCase()
}

function formatMoney(amount) {
  return amount === null || amount === undefined ? '待补录' : '¥' + Number(amount).toFixed(2)
}

function readAmount(value) {
  const text = String(value).trim()
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null
  const amount = Number(text)
  return Number.isSafeInteger(Math.round(amount * 100)) ? amount : null
}

function phoneInput(value) {
  return String(value || '').replace(/[\s()-]+/g, '')
}

function isPhone(value) {
  return /^\+?\d{7,15}$/.test(value)
}

function formatCapacity(min, max) {
  if (max == null) return '人数待补充'
  if (min == null) return `最多 ${max} 人`
  return min === max ? `${max} 人` : `${min}–${max} 人`
}

function floorTone(floor) {
  switch (floor) {
    case '一楼': case '1楼': return 'floor-one'
    case '二楼': case '2楼': return 'floor-two'
    case '三楼': case '3楼': return 'floor-three'
    default: return ''
  }
}

function presentTables(tables, orderId) {
  return tables.map(table => {
    const own = Boolean(orderId && table.orderId === orderId)
    const status = own ? 'own' : (table.orderStatus || (table.orderId ? 'booked' : 'open'))
    const typeLabel = table.id === '卡1' && table.type === 'hall' ? '卡座' : TABLE_TYPES[table.type]
    return {
      ...table,
      status,
      statusLabel: own ? '本单桌位' : (STATUSES[status] || '空桌'),
      typeLabel,
      floorTone: floorTone(table.floor),
      deskMeta: [table.floor, typeLabel].filter(Boolean).join(' · '),
      capacityLabel: formatCapacity(table.minCapacity, table.capacity),
      available: !table.orderId || own,
    }
  })
}

function floorOptions(tables) {
  return [{ id: '', label: '全部楼层' }].concat(
    [...new Set(tables.map(table => table.floor))].map(floor => ({ id: floor, label: floor, floorTone: floorTone(floor) }))
  )
}

function presentOrder(order, today) {
  return {
    ...order,
    dateLabel: dateLabel(order.date, today),
    mealLabel: MEALS[order.meal],
    statusLabel: STATUSES[order.status],
    kindLabel: order.kind === 'walkin' ? '散客' : '预订',
    tableLabel: (order.tableNames || []).join('、'),
  }
}

function errorMessage(error, fallback) {
  return (error && error.message) || fallback
}

function orderUrl(id) {
  return '/pages/order/index?id=' + encodeURIComponent(id)
}

function bookingUrl(date, meal, options = {}) {
  if (options.id) return '/pages/booking/index?id=' + encodeURIComponent(options.id)
  const tableIds = options.tableIds && options.tableIds.length
    ? encodeURIComponent(JSON.stringify(options.tableIds))
    : ''
  return '/pages/booking/index?date=' + date + '&meal=' + meal +
    '&kind=' + (options.kind || 'booking') + (tableIds ? '&tables=' + tableIds : '')
}

module.exports = {
  MEALS, ROLES, TYPES, currentMeal, shiftDate, dateLabel, canBook, canManageOrders, canViewReports, staffCode,
  formatMoney, readAmount, phoneInput, isPhone, formatCapacity, presentTables, floorOptions,
  presentOrder, errorMessage, orderUrl, bookingUrl,
}
