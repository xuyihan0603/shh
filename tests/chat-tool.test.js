const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index'), 'utf8')
const draftKey = 'shh.chatTool.draft'
const now = 1_800_000_000_000

function chatTool(draft) {
  const storage = new Map([[draftKey, draft]])
  let page
  vm.runInNewContext(source, {
    Date: { now: () => now },
    Page(config) {
      page = { ...config, setData(data) { Object.assign(this.data, data) } }
    },
    wx: {
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      getStorageSync: key => storage.get(key),
      removeStorageSync: key => storage.delete(key)
    }
  })
  return { page, storage }
}

test('聊天工具原样回填匹配的长正文，用后清除草稿', () => {
  const text = '预订信息 %20、100% & 桌号 A+B\n'.repeat(12)
  const { page, storage } = chatTool({ token: 'current', text, createdAt: now })
  page.onLoad({ token: 'current' })

  assert.equal(page.data.text, text)
  assert.equal(page.data.hasText, true)
  assert.equal(storage.has(draftKey), false)
})

test('打开过期或无令牌的发送页可以手动输入，并保留未过期的其他草稿', () => {
  const current = { token: 'new', text: '待发送', createdAt: now }
  const { page, storage } = chatTool(current)
  page.onLoad()
  page.onLoad({ token: 'old' })

  assert.equal(page.data.text, '')
  assert.equal(page.data.hasText, false)
  assert.equal(storage.get(draftKey), current)

  storage.set(draftKey, { ...current, createdAt: now - 10 * 60 * 1000 })
  page.onLoad({ token: 'new' })
  assert.equal(page.data.text, '')
  assert.equal(storage.has(draftKey), false)

  page.onInput({ detail: { value: '  \n' } })
  assert.equal(page.data.hasText, false)
  page.onInput({ detail: { value: '手动粘贴的预订通知' } })
  assert.equal(page.data.hasText, true)
})

test('正文通过微信文本表单发送，且消息不附加小程序入口', () => {
  const template = fs.readFileSync(require.resolve('../miniprogram/chat-tool/pages/send/index.wxml'), 'utf8')
  assert.match(template, /<form\b[^>]*\bbind:submitToGroup="onSubmitToGroup"/)
  const form = template.match(/<form\b[^>]*>([\s\S]*?)<\/form>/)[1]
  assert.match(form, /<textarea\b[^>]*\bvalue="{{text}}"[^>]*\bmaxlength="{{-1}}"/)
  const button = form.match(/<button\b[^>]*\bform-type="submitToGroup"[^>]*>/)[0]
  assert.match(button, /\bneed-show-entrance="{{false}}"/)
  assert.match(button, /\bdisabled="{{!hasText}}"/)
})
