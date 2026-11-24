const { call, openAccess } = require('../../lib/api')
const { canManageOrders, errorMessage, formatMoney } = require('../../lib/reception')

const emptyResults = { customers: [], next: '', loadingMore: false, moreError: '' }
const accessErrors = ['UNAUTHORIZED', 'FORBIDDEN', 'NAME_REQUIRED', 'ACCESS_PENDING']

Page({
  data: {
    ...emptyResults, draft: '', query: '', ready: false, loading: true, error: '', needsAccount: false,
  },

  onShow() { return this.refresh() },
  onHide() {
    this.requestId = (this.requestId || 0) + 1
    this.setData({ ...emptyResults, ready: false })
  },
  onUnload() { this.requestId = (this.requestId || 0) + 1 },

  async onPullDownRefresh() {
    try { await this.refresh() } finally { wx.stopPullDownRefresh() }
  },

  async refresh() {
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ ...emptyResults, ready: false, loading: true, error: '', needsAccount: false })
    try {
      const { me } = await call('bootstrap')
      if (requestId !== this.requestId) return
      if (me.role === 'pending') return openAccess()
      if (!me.nameBound || !canManageOrders(me.role)) {
        this.setData({
          draft: '', query: '', loading: false, needsAccount: true,
          error: me.nameBound ? '仅店长和管理员可查看客户档案。' : '请在「我的」填写员工姓名。',
        })
        return
      }
      if (this.actorId !== me.id) this.setData({ draft: '', query: '' })
      this.actorId = me.id
      this.setData({ ready: true })
      return this.loadCustomers()
    } catch (error) {
      if (requestId !== this.requestId) return
      this.setData({ loading: false, error: errorMessage(error, '无法加载客户档案，请重试。'),
        needsAccount: accessErrors.includes(error.code) })
    }
  },

  async loadCustomers(append = false) {
    const { ready, query, next, loading, loadingMore } = this.data
    if (!ready || (append && (!next || loading || loadingMore))) return
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData(append ? { loadingMore: true, moreError: '' }
      : { ...emptyResults, loading: true, error: '', needsAccount: false })
    try {
      const result = await call('customerDirectory', append ? { query, afterPhone: next } : { query })
      if (requestId !== this.requestId) return
      const rows = result.customers.map(customer => ({ ...customer, amountText: formatMoney(customer.amount) }))
      this.setData({ customers: append ? this.data.customers.concat(rows) : rows, next: result.next,
        loading: false, loadingMore: false })
    } catch (error) {
      if (requestId !== this.requestId) return
      const message = errorMessage(error, '无法加载客户档案，请重试。')
      const needsAccount = accessErrors.includes(error.code)
      if (append && !needsAccount) {
        this.setData({ loadingMore: false, moreError: message })
        return
      }
      this.setData({ ...emptyResults, ready: !needsAccount, loading: false, error: message, needsAccount,
        ...(needsAccount ? { draft: '', query: '' } : {}) })
    }
  },

  changeDraft(event) { this.setData({ draft: event.detail.value }) },
  search(event) {
    const query = (event.detail?.value ?? this.data.draft).trim()
    this.setData({ query, draft: query })
    return this.loadCustomers()
  },
  clearSearch() {
    this.setData({ draft: '', query: '' })
    return this.loadCustomers()
  },
  loadMore() { return this.loadCustomers(true) },
  retry() { return this.data.ready ? this.loadCustomers() : this.refresh() },
  openAccount() { wx.switchTab({ url: '/pages/account/index' }) },
})
