const { call, today, openAccess, openReport } = require('../../lib/api')
const { MEALS, orderUrl } = require('../../lib/reception')

const statuses = { booked: '已预订', arrived: '已到店', settled: '已结账', cancelled: '已取消' }
const ORDERS_PER_PAGE = 40
const allOrders = { staffId: '', selectedStaff: null, pendingOnly: false }
const emptyContext = { contextReady: false, canViewInsights: false }

function money(value) {
  const [integer, cents] = Number(value).toFixed(2).split('.')
  return `¥${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}

function periodDate(date, period) {
  return period === 'month' ? date.slice(0, 7) : date
}

function isAmountPending(order) {
  return order.amount == null && order.status !== 'cancelled'
}

function orderDetails(order) {
  return {
    id: order.id,
    status: order.status,
    time: order.time,
    staffName: order.kind === 'walkin' ? '散客' : order.ownerName,
    date: order.date,
    mealLabel: MEALS[order.meal],
    statusLabel: statuses[order.status],
    tables: order.tableNames.join('、'),
    tableCount: order.tableIds.length,
    amountPending: isAmountPending(order),
    amountText: order.amount == null ? (order.status === 'cancelled' ? '未录' : '待补') : money(order.amount),
    depositText: money(order.deposit)
  }
}

Page({
  data: {
    date: today(),
    period: 'day',
    dateLabel: '',
    loading: true,
    exporting: false,
    error: '',
    needsName: false,
    ...emptyContext,
    ...allOrders,
    report: null,
    details: [],
    hasMoreOrders: false,
  },

  onShow() {
    return this.refresh(true)
  },

  onHide() {
    this.requestId = (this.requestId || 0) + 1
    this.orders = []
    this.filteredOrders = []
  },

  onUnload() {
    this.onHide()
  },

  async onPullDownRefresh() {
    try {
      await this.refresh(true)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  chooseDate(event) {
    const { value } = event.detail
    this.dateMode = 'chosen'
    return this.showDate(this.data.period === 'month' ? value.slice(0, 7) + '-01' : value)
  },

  showDate(date) {
    if (date === this.data.date) return
    const { period } = this.data
    const changedPeriod = periodDate(date, period) !== periodDate(this.data.date, period)
    this.setData({ date, ...(changedPeriod ? allOrders : {}) })
    return this.refresh()
  },

  choosePeriod(event) {
    const { period } = event.currentTarget.dataset
    if (period === this.data.period) return
    this.setData({ period, ...allOrders })
    return this.refresh()
  },

  async refresh(recheckContext) {
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    const loadContext = recheckContext === true || !this.data.contextReady || !this.account
    this.orders = []
    this.filteredOrders = []
    this.setData({
      loading: true, error: '', needsName: false, report: null, details: [], hasMoreOrders: false,
      ...(loadContext ? { ...emptyContext, selectedStaff: null } : {}),
    })
    try {
      if (loadContext) {
        const { me } = await call('bootstrap')
        if (requestId !== this.requestId) return
        if (me.role === 'pending') return openAccess()
        const account = [me.id, me.role].join(':')
        const changedAccount = this.account !== account
        if (changedAccount) this.dateMode = ''
        this.account = account
        const canReport = me.role === 'manager' || me.role === 'finance'
        this.setData({
          ...(changedAccount ? { ...allOrders, period: 'day' } : {}),
          contextReady: true,
          canViewInsights: canReport && me.nameBound === true,
        })
      }
      const { period } = this.data
      const date = this.dateMode === 'chosen' ? this.data.date : today()
      const dateLabel = periodDate(date, period)
      this.setData({
        date, dateLabel,
        ...(dateLabel === periodDate(this.data.date, period) ? {} : allOrders),
      })
      const result = await call('report', { date, period })
      if (requestId !== this.requestId) return
      this.orders = result.details
      const report = {
        total: { ...result.total, amountText: money(result.total.amount), depositText: money(result.total.deposit) },
        rows: result.rows.map(row => ({ ...row, amountText: money(row.amount) }))
      }
      const row = report.rows.find(item => item.staffId === this.data.staffId)
      const staffId = row ? row.staffId : ''
      this.setData({ report, staffId, selectedStaff: row || null, ...this.filterOrders(staffId, this.data.pendingOnly) })
    } catch (error) {
      if (requestId !== this.requestId) return
      const unauthorized = ['UNAUTHORIZED', 'FORBIDDEN', 'NAME_REQUIRED'].includes(error.code)
      if (unauthorized) this.account = ''
      this.setData({
        ...(unauthorized ? { ...allOrders, canViewInsights: false } : {}),
        needsName: error.code === 'NAME_REQUIRED', error: error.message || '财务报表加载失败，请重试。',
      })
    } finally {
      if (requestId === this.requestId) this.setData({ loading: false })
    }
  },

  filterOrders(staffId, pendingOnly) {
    this.filteredOrders = this.orders.filter(order => {
      const owner = order.kind === 'walkin' ? 'walkin' : order.ownerId
      return (!staffId || owner === staffId) && (!pendingOnly || isAmountPending(order))
    })
    return {
      details: this.filteredOrders.slice(0, ORDERS_PER_PAGE).map(orderDetails),
      hasMoreOrders: this.filteredOrders.length > ORDERS_PER_PAGE,
    }
  },

  moreOrders() {
    if (!this.data.hasMoreOrders) return
    const shown = this.data.details.length
    const orders = this.filteredOrders.slice(shown, shown + ORDERS_PER_PAGE)
    const update = { hasMoreOrders: shown + orders.length < this.filteredOrders.length }
    orders.forEach((order, index) => { update[`details[${shown + index}]`] = orderDetails(order) })
    this.setData(update)
  },

  selectStaff(event) {
    const { staffId, pendingOnly = false } = event.currentTarget.dataset
    const { report } = this.data
    if (!report) return
    const row = report.rows.find(item => item.staffId === staffId)
    const selected = row ? row.staffId : ''
    this.setData({
      staffId: selected, selectedStaff: row || null, pendingOnly,
      ...this.filterOrders(selected, pendingOnly),
    }, () => {
      if (row || pendingOnly) wx.pageScrollTo({ selector: '#report-orders', duration: 200 })
    })
  },

  openOrder(event) {
    const { id } = event.currentTarget.dataset
    const order = this.data.details.find(item => item.id === id)
    if (order) wx.navigateTo({ url: orderUrl(id) + (order.amountPending ? '&supplementAmount=1' : '') })
  },

  openInsights() {
    if (this.data.canViewInsights) wx.navigateTo({ url: '/pages/insights/index' })
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' })
  },

  async exportReport() {
    if (this.data.exporting || this.data.loading || !this.data.report) return
    const { date, period } = this.data
    this.setData({ exporting: true })
    try {
      await openReport(date, period)
    } catch (error) {
      wx.showModal({ title: '导出失败', content: error.message || '文件暂时无法打开，请重试。', showCancel: false })
    } finally {
      this.setData({ exporting: false })
    }
  }
})
