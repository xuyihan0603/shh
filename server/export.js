const { buildWorkbook } = require('../miniprogram/lib/workbook')

module.exports = { buildWorkbook: report => Buffer.from(buildWorkbook(report)) }
