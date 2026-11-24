const { call, today, openAccess } = require('../../lib/api')
const { currentMeal, dateLabel, canBook, canManageOrders, presentOrder, errorMessage, orderUrl, bookingUrl, phoneInput, isPhone } =
  require('../../lib/reception')

const EMPTY_RESULTS = { customer: null, orders: [], total: 0, next: '', loadingMore: false, moreError: '' }

Page({
  data: {
    date: '',
    dateLabel: '',
    canViewAll: false,
    allDates: false,
    meal: '',
    meals: [{ id: '', label: '全部餐段' }, { id: 'lunch', label: '午餐' }, { id: 'dinner', label: '晚餐' }],
    canLookup: false,
    phoneDraft: '',
    queryPhone: '',
    ...EMPTY_RESULTS,
    contextReady: false,
    loading: true,
    error: '',
    needsName: false,
  },

  onLoad() {
    const date = today()
    this.setData({ date, dateLabel: dateLabel(date, date) })
  },

  onShow() {
    return this.refresh()
  },

  onHide() {
    this.contextRequest = (this.contextRequest || 0) + 1
    this.resultRequest = (this.resultRequest || 0) + 1
  },

  onUnload() { this.onHide() },

  async onPullDownRefresh() {
    try {
      await this.refresh()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async refresh() {
    const request = (this.contextRequest || 0) + 1
    this.contextRequest = request
    this.resultRequest = (this.resultRequest || 0) + 1
    this.setData({
      ...EMPTY_RESULTS, contextReady: false, canLookup: false, canViewAll: false,
      loading: true, error: '', needsName: false,
    })
    try {
      const { me } = await call('bootstrap')
      if (request !== this.contextRequest) return
      if (me.role === 'pending') return openAccess()
      if (me.nameBound === false) {
        this.setData({
          loading: false, needsName: true, phoneDraft: '', queryPhone: '',
          error: '请先填写员工姓名，再查看订单。',
        })
        return
      }
      const canLookup = canBook(me.role)
      const canViewAll = canManageOrders(me.role)
      const actorKey = [me.id, me.role].join('/')
      const sameActor = actorKey === this.actorKey
      const currentDate = today()
      const date = sameActor ? this.data.date : currentDate
      this.actorKey = actorKey
      this.setData({
        canLookup, canViewAll, contextReady: true,
        date, dateLabel: dateLabel(date, currentDate),
        allDates: canViewAll && (!sameActor || this.data.allDates),
        ...(sameActor ? {} : { meal: '' }),
        ...(canLookup && sameActor ? {} : { phoneDraft: '', queryPhone: '' }),
      })
      await this.loadResults()
    } catch (error) {
      if (request !== this.contextRequest) return
      this.setData({
        loading: false, canLookup: false,
        needsName: error.code === 'NAME_REQUIRED',
        error: errorMessage(error, '订单加载失败，请重试。'),
      })
    }
  },

  async loadResults(append = false) {
    const { contextReady, date, allDates, meal, queryPhone, next: beforeId, loading, loadingMore } = this.data
    if (!contextReady || (append && (!allDates || queryPhone || !beforeId || loading || loadingMore))) return
    const request = (this.resultRequest || 0) + 1
    this.resultRequest = request
    this.setData(append
      ? { loadingMore: true, moreError: '' }
      : { ...EMPTY_RESULTS, loading: true, error: '', needsName: false })
    try {
      let customer = null
      let orders
      let total
      let next = ''
      if (queryPhone) {
        customer = await call('customer', { phone: queryPhone })
        orders = customer ? customer.orders : []
      } else if (allDates) {
        const page = await call('storeOrders', append ? { meal, beforeId } : { meal })
        orders = page.orders
        total = page.total
        next = page.next
      } else {
        orders = await call('orders', { date, meal })
      }
      if (request !== this.resultRequest) return
      const currentDate = today()
      const rows = orders.map(order => presentOrder(order, currentDate))
      this.setData({
        customer, orders: append ? this.data.orders.concat(rows) : rows,
        total: total ?? rows.length, next, loading: false, loadingMore: false,
      })
    } catch (error) {
      if (request !== this.resultRequest) return
      const message = errorMessage(error, '订单加载失败，请重试。')
      const needsName = error.code === 'NAME_REQUIRED'
      const contextLost = ['UNAUTHORIZED', 'NAME_REQUIRED', 'FORBIDDEN', 'ACCESS_PENDING'].includes(error.code)
      if (append && !contextLost && error.code !== 'VALIDATION') {
        this.setData({ loadingMore: false, moreError: message })
        return
      }
      this.setData({
        ...EMPTY_RESULTS, loading: false, needsName, error: message,
        ...(contextLost ? { contextReady: false, canLookup: false, canViewAll: false } : {}),
      })
    }
  },

  loadMore() {
    return this.loadResults(true)
  },

  retry() {
    return this.data.contextReady ? this.loadResults() : this.refresh()
  },

  pickDateScope(event) {
    const allDates = event.currentTarget.dataset.scope === 'all'
    if (!this.data.canViewAll || this.data.queryPhone || allDates === this.data.allDates) return
    this.setData({ allDates })
    return this.loadResults()
  },

  pickDate(event) {
    const date = event.detail.value
    if (!this.data.contextReady || this.data.queryPhone || this.data.allDates || date === this.data.date) return
    this.setData({ date, dateLabel: dateLabel(date, today()) })
    return this.loadResults()
  },

  pickMeal(event) {
    const meal = event.currentTarget.dataset.meal || ''
    if (!this.data.contextReady || this.data.queryPhone || meal === this.data.meal) return
    this.setData({ meal })
    return this.loadResults()
  },

  changePhone(event) {
    this.setData({ phoneDraft: event.detail.value })
  },

  searchPhone(event) {
    if (!this.data.canLookup || !this.data.contextReady) return
    const phone = phoneInput(event.detail.value || this.data.phoneDraft)
    if (!isPhone(phone)) {
      wx.showToast({ title: '请输入正确的联系电话', icon: 'none' })
      return
    }
    this.setData({ queryPhone: phone, phoneDraft: phone })
    return this.loadResults()
  },

  resetSearch() {
    this.setData({ phoneDraft: '', queryPhone: '' })
    return this.loadResults()
  },

  useCustomer() {
    const { canLookup, queryPhone, customer, date, allDates, meal, loading, error } = this.data
    if (!canLookup || !queryPhone || loading || error) return
    wx.navigateTo({
      url: bookingUrl(allDates ? today() : date, meal || currentMeal()),
      success({ eventChannel }) {
        eventChannel.emit('customer', { phone: customer ? customer.phone : queryPhone })
      },
    })
  },

  openOrder(event) {
    wx.navigateTo({ url: orderUrl(event.currentTarget.dataset.id) })
  },

  openAccount() {
    wx.switchTab({ url: '/pages/account/index' })
  },
})
