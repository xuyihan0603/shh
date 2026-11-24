const PADDING = 36
const PHOTO_GAP = 22
const MAX_PHOTO_HEIGHT = 690
const MIN_PHOTO_HEIGHT = 340
// WeChat limits a Canvas 2D component's backing dimensions to 1365 × 1365.
const MAX_CANVAS_SIDE = 1365
const layouts = [[736, 32], [736, 30], [736, 28], [960, 32], [1140, 30], [1360, 26]]

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null
const emojiJoiner = '\u200d'
const graphemeExtension = /^[\p{M}\u200d\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]$/u
const regionalIndicator = /^[\u{1f1e6}-\u{1f1ff}]$/u
const wordCharacter = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9_'’-]/

function splitGraphemes(text) {
  if (segmenter) return Array.from(segmenter.segment(text), item => item.segment)

  // Keep common emoji sequences together on engines without Intl.Segmenter.
  const groups = []
  let joinNext = false
  let firstFlagCharacter = false
  for (const character of text) {
    const isFlagCharacter = regionalIndicator.test(character)
    if (groups.length && (joinNext || graphemeExtension.test(character) || (firstFlagCharacter && isFlagCharacter))) {
      groups[groups.length - 1] += character
    } else {
      groups.push(character)
    }
    joinNext = character === emojiJoiner
    firstFlagCharacter = isFlagCharacter && !firstFlagCharacter
  }
  return groups
}

function canBreakAfter(character, nextCharacter) {
  if (/^[（【《「『“‘(]/.test(character) || /^[\s、，。！？：；…）】》」』”’.,!?;:%)]/.test(nextCharacter)) return false
  return !(wordCharacter.test(character) && wordCharacter.test(nextCharacter))
}

function wrapLine(context, characters, availableWidth) {
  const rows = []
  let start = 0
  let preferredBreak = 0
  let row = ''

  for (let index = 0; index < characters.length; index++) {
    const character = characters[index]
    const next = row + character
    if (context.measureText(next).width > availableWidth) {
      if (!row) return null
      const end = preferredBreak > start ? preferredBreak : index
      rows.push(end === index ? row : characters.slice(start, end).join(''))
      start = end
      preferredBreak = end
      index = end - 1
      row = ''
      continue
    }

    row = next
    if (canBreakAfter(character, characters[index + 1] || '')) preferredBreak = index + 1
  }

  rows.push(row)
  return rows
}

function layoutInvitation(context, text, photo) {
  const paragraphs = text.replace(/\t/g, '    ').split(/\r\n?|\n|\u2028|\u2029/).map(splitGraphemes)
  for (const [width, fontSize] of layouts) {
    const availableWidth = width - 2 * PADDING
    const maxPhotoHeight = photo ? Math.min(MAX_PHOTO_HEIGHT, Math.floor(availableWidth * photo.height / photo.width)) : 0
    const photoGap = photo ? PHOTO_GAP : 0
    const availableHeight = MAX_CANVAS_SIDE - 2 * PADDING - photoGap - Math.min(MIN_PHOTO_HEIGHT, maxPhotoHeight)
    const font = `${fontSize}px sans-serif`
    const lineHeight = Math.ceil(fontSize * 1.4)
    if (paragraphs.length * lineHeight > availableHeight) continue

    context.font = font
    const rows = paragraphs.flatMap(paragraph => wrapLine(context, paragraph, availableWidth))
    const textHeight = rows.length * lineHeight
    if (textHeight > availableHeight || rows.includes(null)) continue

    const photoY = PADDING + textHeight + photoGap
    const photoHeight = Math.min(maxPhotoHeight, MAX_CANVAS_SIDE - photoY - PADDING)
    const photoWidth = photo ? Math.round(photoHeight * photo.width / photo.height) : 0
    const height = photoY + photoHeight + PADDING
    return { rows, font, fontSize, lineHeight, width, height, photoY, photoWidth, photoHeight }
  }
  const error = new Error('预订正文太长，无法生成清晰的图片。')
  error.code = 'TEXT_TOO_LONG'
  throw error
}

function loadPhoto(canvas, photoPath) {
  return new Promise((resolve, reject) => {
    const photo = canvas.createImage()
    const fail = () => reject(new Error('无法读取门头照片。'))
    photo.onload = () => {
      if (photo.width > 0 && photo.height > 0) resolve(photo)
      else fail()
    }
    photo.onerror = fail
    photo.src = photoPath
  })
}

function exportImage(canvas, width, height) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('无法导出预订图片。'))
    wx.canvasToTempFilePath({
      canvas, x: 0, y: 0, width, height,
      destWidth: width, destHeight: height, fileType: 'jpg', quality: 0.94,
      success: ({ tempFilePath }) => tempFilePath ? resolve(tempFilePath) : fail(),
      fail,
    })
  })
}

async function createInvitationImage(canvas, text, photoPath = null) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('没有可生成图片的预订正文。')
  if (typeof canvas?.getContext !== 'function' || typeof wx.canvasToTempFilePath !== 'function') {
    throw new Error('当前微信无法生成预订图片。')
  }

  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前微信无法绘制预订图片。')

  const photo = photoPath ? await loadPhoto(canvas, photoPath) : null
  const { rows, font, fontSize, lineHeight, width, height, photoY, photoWidth, photoHeight } = layoutInvitation(context, text, photo)
  canvas.width = width
  canvas.height = height

  context.fillStyle = '#F6F4EE'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#103947'
  context.font = font
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  rows.forEach((row, index) => {
    if (row) context.fillText(row, PADDING, PADDING + fontSize + index * lineHeight)
  })
  if (photo) context.drawImage(photo, (width - photoWidth) / 2, photoY, photoWidth, photoHeight)

  return exportImage(canvas, width, height)
}

module.exports = { createInvitationImage }
