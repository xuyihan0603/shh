const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index'), 'utf8')
const draftKey = 'shh.chatTool.draft'
const now = 1_800_000_000_000
const maxAge = 10 * 60 * 1000
const token = 'current'
const text = '本店地址:江学路381弄22号\n' + '预订信息 %20、100% & 桌号 A+B 🦞\n'.repeat(12)
const draft = { token, text, createdAt: now }

function chatTool(storage = new Map([[draftKey, draft]])) {
  let page
  vm.runInNewContext(source, {
    Date: { now: () => now },
    Page(config) {
      page = { ...config, setData(data) { Object.assign(this.data, data) } }
    },
    wx: {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      getStorageSync: key => storage.get(key),
      removeStorageSync: key => storage.delete(key),
      canIUse: () => true,
    },
  })
  return { page, storage }
}

test('聊天工具原样回填含地址的长正文，并在使用后清除草稿', () => {
  const { page, storage } = chatTool()
  page.onLoad({ token })
  assert.equal(page.data.text, text)
  assert.equal(storage.has(draftKey), false)

  const reopened = chatTool(storage)
  reopened.page.onLoad({ token })
  assert.equal(reopened.page.data.text, '')
})

test('未匹配令牌的入口保留有效草稿，过期和旧版图片草稿无法发送', () => {
  const { storage } = chatTool()
  for (const query of [{}, { token: 'other' }]) {
    const { page } = chatTool(storage)
    page.onLoad(query)
    assert.equal(page.data.text, '')
    assert.equal(storage.get(draftKey), draft)
  }

  for (const invalid of [
    { ...draft, createdAt: now - maxAge },
    { ...draft, createdAt: now + 1 },
    { token, invitationImagePath: 'wxfile://usr/shh-invite-current.jpg', createdAt: now },
  ]) {
    storage.set(draftKey, invalid)
    const { page } = chatTool(storage)
    page.onLoad({ token })
    assert.equal(page.data.text, '')
    assert.equal(storage.has(draftKey), false)
  }
})

test('微信原生文本表单发送完整正文，且不附加小程序入口', () => {
  const template = fs.readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index.wxml'), 'utf8')
  const form = template.match(/<form\b[^>]*\bbind:submitToGroup="onSubmitToGroup"[^>]*>([\s\S]*?)<\/form>/)
  assert.ok(form)
  assert.match(form[0], /<form\b[^>]*\bwx:if="{{hasDraft}}"/)
  const field = form[1].match(/<textarea\b[^>]*\bvalue="{{text}}"[^>]*>/)
  assert.ok(field)
  assert.match(field[0], /\bmaxlength="{{-1}}"/)
  assert.match(field[0], /\bbindinput="onInput"/)
  const button = form[1].match(/<button\b[^>]*\bform-type="submitToGroup"[^>]*>/)
  assert.ok(button)
  assert.match(button[0], /\bneed-show-entrance="{{false}}"/)
  assert.match(button[0], /\bdisabled="{{[^"]*\bsubmitted\b[^"]*}}"/)
  assert.match(button[0], /\bdisabled="{{[^"]*!hasText\b[^"]*}}"/)
})

test('确认发送前可以编辑正文，清空后保留输入框', () => {
  const { page } = chatTool()
  page.onLoad({ token })
  page.onInput({ detail: { value: '  \n' } })
  assert.equal(page.data.hasDraft, true)
  assert.equal(page.data.hasText, false)

  const revised = text + '请提前十分钟到店。'
  page.onInput({ detail: { value: revised } })
  assert.equal(page.data.text, revised)
  assert.equal(page.data.hasText, true)
})

test('原生文字发送取消或失败后保留正文，并允许重试', () => {
  const { page } = chatTool()
  page.onLoad({ token })

  page.onSubmitToGroup({ detail: { errMsg: 'submitToGroup:fail cancel' } })
  assert.equal(page.data.submitted, false)
  assert.match(page.data.notice, /已取消.*重试/)

  page.onSubmitToGroup({ detail: { errMsg: 'submitToGroup:fail system error' } })
  assert.equal(page.data.submitted, false)
  assert.equal(page.data.text, text)
  assert.match(page.data.notice, /复制原文/)

  page.onSubmitToGroup({ detail: { errMsg: 'submitToGroup:ok' } })
  assert.equal(page.data.submitted, true)
  assert.match(page.data.notice, /在微信聊天中查看发送结果/)
})
