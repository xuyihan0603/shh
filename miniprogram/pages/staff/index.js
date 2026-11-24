const api = require('../../lib/api')
const { ROLES, staffCode, errorMessage } = require('../../lib/reception')

const roleOptions = ['sales', 'finance', 'manager', 'pending'].map(role => ({ role, label: ROLES[role] }))
const closedEditor = { editId: '', editMode: '', roleIndex: -1, editName: '', editPhone: '', editError: '' }
const accessErrors = ['UNAUTHORIZED', 'NAME_REQUIRED', 'FORBIDDEN']

function presentStaff(person, self) {
  return {
    ...person, self, code: staffCode(person.id), roleLabel: ROLES[person.role],
    roleIndex: roleOptions.findIndex(option => option.role === person.role),
  }
}

Page({
  data: {
    roleOptions, staff: [], ...closedEditor,
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
    this.setData({ loading: true, staff: [], ...closedEditor, needsAccount: false, error: '', notice: '' })
    try {
      const { me } = await api.call('bootstrap')
      if (requestId !== this.requestId) return
      if (me.role === 'pending') return api.openAccess()
      if (!me.nameBound || me.role !== 'admin') {
        this.setData({
          needsAccount: true,
          error: me.nameBound ? '仅管理员可编辑员工资料和权限。' : '请到「我的」绑定员工姓名。',
        })
        return
      }

      const people = await api.call('staffRoles')
      if (requestId !== this.requestId) return
      const staff = people.map(person => presentStaff(person, person.id === me.id))
        .sort((left, right) => Number(right.role === 'pending') - Number(left.role === 'pending'))
      this.setData({ staff })
      return staff
    } catch (error) {
      if (requestId !== this.requestId) return
      this.setData({
        error: errorMessage(error, '员工权限加载失败，请重试。'),
        needsAccount: accessErrors.includes(error.code),
      })
    } finally {
      if (requestId === this.requestId) this.setData({ loading: false })
    }
  },

  openAccount() { wx.switchTab({ url: '/pages/account/index' }) },

  editProfile(event) {
    if (this.data.loading || this.saving) return
    const person = this.data.staff.find(item => item.id === event.currentTarget.dataset.id)
    if (!person) return
    this.setData({
      ...closedEditor, editId: person.id, editMode: 'profile',
      editName: person.name || '', editPhone: person.servicePhone || '', notice: '',
    })
  },

  editProfileField(event) {
    const { id, field } = event.currentTarget.dataset
    if (this.saving || this.data.editMode !== 'profile' || this.data.editId !== id) return
    if (field === 'editName' || field === 'editPhone') {
      this.setData({ [field]: event.detail.value, editError: '' })
    }
  },

  async saveProfile(event) {
    const { staff, editId, editMode, editName, editPhone, loading } = this.data
    if (loading || this.saving || editMode !== 'profile' || editId !== event.currentTarget.dataset.id) return
    const person = staff.find(item => item.id === editId)
    if (!person) return
    const name = editName.trim()
    if (!name) {
      this.setData({ editError: '请填写员工姓名。' })
      return
    }
    const servicePhone = editPhone.trim()
    const expectedServicePhone = person.servicePhone || ''
    if (person.nameBound && name === person.name && servicePhone === expectedServicePhone) return

    const requestId = this.requestId
    this.saving = true
    this.setData({ saving: true, editError: '' })
    try {
      const saved = await api.call('setStaffProfile', {
        id: person.id, name, servicePhone, expectedName: person.name || '', expectedServicePhone,
      })
      if (!this.visible) return
      if (requestId !== this.requestId) {
        await this.refresh()
        return
      }
      this.setData({
        staff: staff.map(item => item.id === person.id ? presentStaff(saved, person.self) : item),
        ...closedEditor,
      })
      wx.showToast({ title: '资料已保存' })
    } catch (error) {
      if (!this.visible || requestId !== this.requestId) return
      if (error.code === 'VERSION_CONFLICT' || accessErrors.includes(error.code)) {
        const refresh = this.refresh()
        const refreshId = this.requestId
        const current = await refresh
        if (current && this.visible && refreshId === this.requestId) {
          this.setData({ notice: errorMessage(error, '员工资料已更新，请核对后重新编辑。') })
        }
      } else {
        this.setData({ editError: errorMessage(error, '员工资料保存失败，请重试。') })
      }
    } finally {
      this.saving = false
      if (this.visible) this.setData({ saving: false })
    }
  },

  editRole(event) {
    if (this.data.loading || this.saving) return
    const person = this.data.staff.find(item => item.id === event.currentTarget.dataset.id)
    if (!person || person.self) return
    this.setData({ ...closedEditor, editId: person.id, editMode: 'role', roleIndex: person.roleIndex, notice: '' })
  },

  chooseRole(event) {
    const roleIndex = Number(event.detail.value)
    if (this.saving || this.data.editMode !== 'role' || this.data.editId !== event.currentTarget.dataset.id || !roleOptions[roleIndex]) return
    this.setData({ roleIndex })
  },

  cancelEdit() {
    if (!this.saving) this.setData(closedEditor)
  },

  async saveRole(event) {
    const { staff, editId, editMode, roleIndex, loading } = this.data
    if (loading || this.saving || editMode !== 'role' || editId !== event.currentTarget.dataset.id) return
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
