const { call, today, openAccess } = require('../../lib/api')
const { SEGMENTS } = require('../../lib/customer-segments')
const { canViewReports } = require('../../lib/reception')

function totalFor(counts) {
  return SEGMENTS.reduce((sum, { id }) => sum + counts[id], 0)
}

function weekBreakdown(rows, index) {
  const row = rows[index]
  const previous = rows[index - 1]
  return SEGMENTS.map(({ id, label }) => {
    const difference = previous ? row[id] - previous[id] : 0
    return {
      id, label, count: row[id],
      change: !previous ? '' : difference === 0 ? '与上周持平'
        : '较上周' + (difference > 0 ? '多 ' : '少 ') + Math.abs(difference) + ' 人',
    }
  })
}

Page({
  data: {
    endDate: today(), maxDate: today(), weeks: 4, ranges: [4, 8],
    loading: true, error: '', needsAccount: false,
    total: 0, distribution: [], rows: [], selected: '', breakdown: [], hasVisits: false,
  },

  onShow() { return this.refresh(true) },
  onHide() { this.requestId = (this.requestId || 0) + 1 },
  onUnload() { this.onHide() },
  async onPullDownRefresh() {
    try { await this.refresh(true) } finally { wx.stopPullDownRefresh() }
  },

  async refresh(checkAccount = false) {
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ loading: true, error: '', needsAccount: false, rows: [], distribution: [], breakdown: [] })
    try {
      const maxDate = today()
      if (checkAccount || !this.actorKey) {
        const { me } = await call('bootstrap')
        if (requestId !== this.requestId) return
        if (me.role === 'pending') return openAccess()
        if (me.nameBound === false || !canViewReports(me.role)) {
          this.actorKey = ''
          this.setData({ loading: false, needsAccount: true, error: me.nameBound === false
            ? '请先在「我的」中绑定姓名。' : '当前职位无法查看客群分析。' })
          return
        }
        const actorKey = [me.id, me.role].join('/')
        if (this.actorKey !== actorKey) {
          this.setData({ endDate: maxDate, weeks: 4, selected: '' })
          this.followToday = true
        }
        this.actorKey = actorKey
      }
      const endDate = this.followToday ? maxDate : this.data.endDate
      const result = await call('customerInsights', { endDate, weeks: this.data.weeks })
      if (requestId !== this.requestId) return
      const total = totalFor(result.summary)
      const distribution = SEGMENTS.map(segment => ({
        ...segment, count: result.summary[segment.id],
        percent: total ? 100 * result.summary[segment.id] / total : 0,
      }))
      const peak = Math.max(1, ...result.buckets.map(totalFor))
      const rows = result.buckets.map(bucket => ({
        ...bucket, total: totalFor(bucket),
        dateRange: bucket.startDate.slice(5).replace('-', '/') + '–' + bucket.endDate.slice(5).replace('-', '/'),
        bars: SEGMENTS.map(({ id }) => ({ id, width: 100 * bucket[id] / peak })),
      }))
      const match = rows.findIndex(row => row.endDate === this.data.selected)
      const index = match < 0 ? rows.length - 1 : match
      this.setData({ endDate, maxDate, distribution, total, rows, selected: rows[index].endDate,
        hasVisits: rows.some(row => row.total > 0), breakdown: weekBreakdown(rows, index), loading: false })
    } catch (error) {
      if (requestId !== this.requestId) return
      const needsAccount = ['UNAUTHORIZED', 'FORBIDDEN', 'NAME_REQUIRED'].includes(error.code)
      this.setData({ loading: false, error: error.message || '客群分析加载失败，请重试。', needsAccount })
    }
  },

  changeRange(event) {
    const weeks = Number(event.currentTarget.dataset.weeks)
    if (weeks === this.data.weeks || ![4, 8].includes(weeks)) return
    this.setData({ weeks, selected: '' })
    return this.refresh()
  },
  changeDate(event) { return this.useDate(event.detail.value) },
  useToday() { return this.useDate(today()) },
  useDate(endDate) {
    this.followToday = endDate === today()
    this.setData({ endDate, selected: '' })
    return this.refresh()
  },
  selectWeek(event) {
    const index = this.data.rows.findIndex(row => row.endDate === event.currentTarget.dataset.end)
    if (index < 0) return
    this.setData({ selected: this.data.rows[index].endDate, breakdown: weekBreakdown(this.data.rows, index) })
  },
  retry() { return this.refresh(true) },
  openAccount() { wx.switchTab({ url: '/pages/account/index' }) },
})
