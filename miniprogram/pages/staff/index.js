const api = require('../../lib/api')
const { ROLES, staffCode, errorMessage } = require('../../lib/reception')

const roleOptions = ['front', 'sales', 'finance', 'pending'].map(role => ({ role, label: ROLES[role] }))

Page({
  data: {
    roleOptions, staff: [], editId: '', roleIndex: -1,
    loading: true, saving: false, needsAccount: false, error: '', notice: '',
  },

  onShow() {
    this.visible = true
    this.setData({ saving: !!this.saving })
    return this.refresh()
  },

  onHide() {
    this.visible = false
    this.requestId++
  },

  onUnload() { this.onHide() },

  async onPullDownRefresh() {
    try {
      if (!this.saving) await this.refresh()
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async refresh() {
    const requestId = (this.requestId || 0) + 1
    this.requestId = requestId
    this.setData({ loading: true, staff: [], editId: '', needsAccount: false, error: '', notice: '' })
    try {
      const { me } = await api.call('bootstrap')
      if (requestId !== this.requestId) return
      if (me.role === 'pending') return api.openAccess()
      if (!me.nameBound || me.role !== 'manager') {
        this.setData({
          needsAccount: true,
          error: me.nameBound ? '仅店长可分配员工权限。' : '请到「我的」绑定员工姓名。',
        })
        return
      }

      const people = await api.call('staffRoles')
      if (requestId !== this.requestId) return
      const staff = people.map(person => ({
        ...person, self: person.id === me.id, code: staffCode(person.id), roleLabel: ROLES[person.role],
        roleIndex: roleOptions.findIndex(option => option.role === person.role),
      })).sort((left, right) => Number(right.role === 'pending') - Number(left.role === 'pending'))
      this.setData({ staff })
      return staff
    } catch (error) {
      if (requestId !== this.requestId) return
      this.setData({
        error: errorMessage(error, '员工权限加载失败，请重试。'),
        needsAccount: ['UNAUTHORIZED', 'NAME_REQUIRED', 'FORBIDDEN'].includes(error.code),
      })
    } finally {
      if (requestId === this.requestId) this.setData({ loading: false })
    }
  },

  openAccount() { wx.switchTab({ url: '/pages/account/index' }) },

  editRole(event) {
    if (this.data.loading || this.saving) return
    const person = this.data.staff.find(item => item.id === event.currentTarget.dataset.id)
    if (!person || person.self) return
    this.setData({ editId: person.id, roleIndex: person.roleIndex, notice: '' })
  },

  chooseRole(event) {
    const roleIndex = Number(event.detail.value)
    if (this.saving || !this.data.editId || this.data.editId !== event.currentTarget.dataset.id || !roleOptions[roleIndex]) return
    this.setData({ roleIndex })
  },

  cancelEdit() {
    if (!this.saving) this.setData({ editId: '' })
  },

  async saveRole(event) {
    const { staff, editId, roleIndex, loading } = this.data
    if (loading || this.saving || !editId || editId !== event.currentTarget.dataset.id) return
    const person = staff.find(item => item.id === editId)
    const option = roleOptions[roleIndex]
    if (!person || person.self || !option || option.role === person.role) return

    this.saving = true
    this.setData({ saving: true, notice: '' })
    try {
      let notice = ''
      try {
        await api.call('setStaffRole', { id: person.id, role: option.role, expectedRole: person.role })
      } catch (error) {
        notice = errorMessage(error, '员工职位保存失败，请重试。')
      }

      if (!this.visible) return
      const refresh = this.refresh()
      const requestId = this.requestId
      const current = await refresh
      if (requestId !== this.requestId) return
      if (notice) this.setData({ notice })
      else if (current?.some(item => item.id === person.id && item.role === option.role)) {
        wx.showToast({ title: '权限已保存' })
      } else if (current) {
        this.setData({ notice: '员工职位已变化，请核对当前列表。' })
      }
    } finally {
      this.saving = false
      if (this.visible) this.setData({ saving: false })
    }
  },
})
