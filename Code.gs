// ============================================
// คลังแก้ไฟ กฟส.คำชะอี — Apps Script v3.1
// ============================================

var SS          = SpreadsheetApp.getActiveSpreadsheet();
var SHEET_STOCK = 'stock';
var SHEET_TRUCK = 'truck';
var SHEET_LOGS  = 'logs';

// ============================================
// doGet — ดึงข้อมูล
// ============================================
function doGet(e) {
  try {
    var action = e.parameter.action;
    var result;
    if      (action === 'getStock') result = getSheet(SHEET_STOCK);
    else if (action === 'getTruck') result = getSheet(SHEET_TRUCK);
    else if (action === 'getLogs')  result = getSheet(SHEET_LOGS);
    else result = { error: 'Unknown action: ' + action };
    return out(result);
  } catch(err) {
    return out({ error: err.toString() });
  }
}

// ============================================
// doPost — เขียนข้อมูล + รองรับ LINE Webhook
// ============================================
function doPost(e) {
  try {
    var raw = e.postData.contents;
    var d   = JSON.parse(raw);

    // LINE Webhook (มี events array)
    if (d.events !== undefined) {
      var events = d.events;
      if (events && events.length > 0) {
        var src     = events[0].source;
        var groupId = src && src.groupId;
        if (groupId) {
          PropertiesService.getScriptProperties()
            .setProperty('LINE_GROUP_ID', groupId);
        }
      }
      return ContentService.createTextOutput('OK')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    // action ปกติของแอป
    var action = d.action;
    var result;
    if      (action === 'withdraw')        result = doWithdraw(d);
    else if (action === 'useItem')         result = doUseItem(d);
    else if (action === 'returnItem')      result = doReturnItem(d);
    else if (action === 'returnJob')       result = doReturnJob(d);
    else if (action === 'updateStock')     result = doUpdateStock(d);
    else if (action === 'addItem')         result = doAddItem(d);
    else if (action === 'transfer')        result = doTransfer(d);
    else if (action === 'deleteJob')       result = doDeleteJob(d);
    else if (action === 'updateJobItem')   result = doUpdateJobItem(d);
    else if (action === 'addJobItem')      result = doAddJobItem(d);
    else if (action === 'toggleJobOpened') result = doToggleJobOpened(d);
    else result = { error: 'Unknown action: ' + action };
    return out(result);
  } catch(err) {
    // คืน OK เสมอ เพื่อไม่ให้ LINE retry
    return ContentService.createTextOutput('OK')
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// HELPERS
// ============================================
function getSheet(name) {
  var sh   = SS.getSheetByName(name);
  var data = sh.getDataRange().getValues();
  var keys = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < keys.length; j++) obj[keys[j]] = data[i][j];
    rows.push(obj);
  }
  return { rows: rows };
}

function findRow(sh, code) {
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(code)) return i + 1;
  }
  return -1;
}

function nowTH() {
  var now = new Date();
  var offset = 7 * 60 * 60 * 1000;
  var thai = new Date(now.getTime() + offset);
  var dd   = String(thai.getUTCDate()).padStart(2,'0');
  var mm   = String(thai.getUTCMonth()+1).padStart(2,'0');
  var yyyy = thai.getUTCFullYear() + 543;
  var hh   = String(thai.getUTCHours()).padStart(2,'0');
  var min  = String(thai.getUTCMinutes()).padStart(2,'0');
  return dd+'/'+mm+'/'+yyyy+' '+hh+':'+min;
}

// ============================================
// เบิกของเข้ารถ (stock to truck)
// ============================================
function doWithdraw(d) {
  var shS = SS.getSheetByName(SHEET_STOCK);
  var shT = SS.getSheetByName(SHEET_TRUCK);
  var shL = SS.getSheetByName(SHEET_LOGS);

  var qty  = Number(d.qty);
  var rowS = findRow(shS, d.code);
  var rowT = findRow(shT, d.code);
  if (rowS < 0) return { error: 'ไม่พบรหัส ' + d.code };

  var curS = Number(shS.getRange(rowS, 3).getValue());
  if (curS < qty) return { error: 'ของในคลังไม่พอ เหลือ ' + curS };

  shS.getRange(rowS, 3).setValue(curS - qty);
  if (rowT > 0) {
    var curT = Number(shT.getRange(rowT, 3).getValue());
    shT.getRange(rowT, 3).setValue(curT + qty);
  } else {
    shT.appendRow([d.code, d.name, qty, d.unit, d.cat || '']);
  }
  shL.appendRow(['เบิกของ', d.code, d.name, qty, d.unit, d.shift || '', 'เบิกเข้ารถ', nowTH(), '', '', '']);
  return { success: true };
}

// ============================================
// ใช้ของออกงานแก้ไฟ (truck to ใช้)
// ============================================
function doUseItem(d) {
  var shT   = SS.getSheetByName(SHEET_TRUCK);
  var shL   = SS.getSheetByName(SHEET_LOGS);
  var jobId = 'JOB-' + new Date().getTime();
  var now   = nowTH();
  var results = [];

  for (var i = 0; i < d.items.length; i++) {
    var item = d.items[i];
    var rowT = findRow(shT, item.code);
    if (rowT < 0) { results.push({ error: 'ไม่พบรหัส ' + item.code }); continue; }
    var curT = Number(shT.getRange(rowT, 3).getValue());
    if (curT < item.qty) { results.push({ error: 'ของบนรถไม่พอ: ' + item.name + ' เหลือ ' + curT }); continue; }
    shT.getRange(rowT, 3).setValue(curT - item.qty);
    shL.appendRow(['งานแก้ไฟ', item.code, item.name, item.qty, item.unit,
                   d.shift || '', d.location || '', now,
                   d.lat || '', d.lng || '', jobId, d.note || '']);
    results.push({ success: true, code: item.code, truckQty: curT - item.qty });
  }

  // แจ้งเตือน LINE
  try {
    var itemList = d.items.map(function(i){
      return '  - ' + i.name + ' ' + i.qty + ' ' + i.unit;
    }).join('\n');
    sendLineGroup(
      '⚡ แจ้งเตือนงานแก้ไฟ\n' +
      '📍 จุด: ' + (d.location || '-') + '\n' +
      '👷 กะ: ' + (d.shift || '-') + '\n' +
      '📦 พัสดุ:\n' + itemList + '\n' +
      '📝 หมายเหตุ: ' + (d.note || '-') + '\n' +
      '📌 พิกัด: ' + (d.lat && d.lng ? d.lat + ', ' + d.lng : '-') + '\n' +
      '🕐 เวลา: ' + now

    );
  } catch(lineErr) {}

  return { results: results, jobId: jobId };
}

// ============================================
// คืนของจากรถกลับคลัง (truck to stock)
// ============================================
function doReturnItem(d) {
  var shS = SS.getSheetByName(SHEET_STOCK);
  var shT = SS.getSheetByName(SHEET_TRUCK);
  var shL = SS.getSheetByName(SHEET_LOGS);

  var qty  = Number(d.qty);
  var rowT = findRow(shT, d.code);
  var rowS = findRow(shS, d.code);
  if (rowT < 0) return { error: 'ไม่พบรหัส ' + d.code };

  var curT = Number(shT.getRange(rowT, 3).getValue());
  if (curT < qty) return { error: 'ของบนรถไม่พอ เหลือ ' + curT };

  shT.getRange(rowT, 3).setValue(curT - qty);
  var curS = rowS > 0 ? Number(shS.getRange(rowS, 3).getValue()) : 0;
  if (rowS > 0) shS.getRange(rowS, 3).setValue(curS + qty);
  shL.appendRow(['คืนของ', d.code, d.name, qty, d.unit, d.shift || '', 'คืนจากรถ→คลัง', nowTH(), '', '', '']);
  return { success: true, truckQty: curT - qty, stockQty: curS + qty };
}

// ============================================
// คืนของจากงานกลับรถ
// ============================================
function doReturnJob(d) {
  var shT = SS.getSheetByName(SHEET_TRUCK);
  var shL = SS.getSheetByName(SHEET_LOGS);

  var qty  = Number(d.qty);
  var rowT = findRow(shT, d.code);
  if (rowT < 0) return { error: 'ไม่พบรหัส ' + d.code };

  var curT = Number(shT.getRange(rowT, 3).getValue());
  shT.getRange(rowT, 3).setValue(curT + qty);
  shL.appendRow(['คืนจากงาน', d.code, d.name, qty, d.unit, d.shift || '', d.jobId || '', nowTH(), '', '', '']);
  return { success: true, truckQty: curT + qty };
}

// ============================================
// โอนพัสดุออกจากคลังโดยตรง (ไม่ผ่านรถ)
// ============================================
function doTransfer(d) {
  var shS = SS.getSheetByName(SHEET_STOCK);
  var shL = SS.getSheetByName(SHEET_LOGS);
  if (!d.items || !d.items.length) return { error: 'ไม่มีรายการพัสดุ' };

  var transferId = 'TF-' + new Date().getTime();
  var now  = nowTH();
  var dest = String(d.dest || '');
  var parts = [];
  if (d.receiver) parts.push('ผู้รับ: ' + d.receiver);
  if (d.docNo)    parts.push('เลขเอกสาร: ' + d.docNo);
  if (d.note)     parts.push(String(d.note));
  var note = parts.join(' | ');

  var results = [];
  for (var i = 0; i < d.items.length; i++) {
    var item = d.items[i];
    var rowS = findRow(shS, item.code);
    if (rowS < 0) { results.push({ error: 'ไม่พบรหัส ' + item.code }); continue; }
    var curS = Number(shS.getRange(rowS, 3).getValue());
    if (curS < item.qty) { results.push({ error: 'ของในคลังไม่พอ: ' + item.name + ' เหลือ ' + curS }); continue; }
    shS.getRange(rowS, 3).setValue(curS - item.qty);
    shL.appendRow(['โอนพัสดุ', item.code, item.name, item.qty, item.unit,
                   '', dest, now, '', '', transferId, note]);
    results.push({ success: true, code: item.code, stockQty: curS - item.qty });
  }

  // แจ้งเตือน LINE
  try {
    var itemList = d.items.map(function(i){
      return '  - ' + i.name + ' ' + i.qty + ' ' + i.unit;
    }).join('\n');
    sendLineGroup(
      '📤 แจ้งเตือนโอนพัสดุ\n' +
      '🏢 ปลายทาง: ' + (dest || '-') + '\n' +
      '👤 ผู้รับ: ' + (d.receiver || '-') + '\n' +
      '📄 เลขเอกสาร: ' + (d.docNo || '-') + '\n' +
      '📦 พัสดุ:\n' + itemList + '\n' +
      '📝 หมายเหตุ: ' + (d.note || '-') + '\n' +
      '🕐 เวลา: ' + now
    );
  } catch(lineErr) {}

  return { results: results, transferId: transferId };
}

// ============================================
// ลบงานแก้ไฟ
// ============================================
function doDeleteJob(d) {
  var shT  = SS.getSheetByName(SHEET_TRUCK);
  var shL  = SS.getSheetByName(SHEET_LOGS);
  var data = shL.getDataRange().getValues();

  var rowsToDelete = [];
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][10]) === String(d.jobId)) {
      var code = String(data[i][1]);
      var qty  = Number(data[i][3]);
      var rowT = findRow(shT, code);
      if (rowT > 0) {
        var curT = Number(shT.getRange(rowT, 3).getValue());
        shT.getRange(rowT, 3).setValue(curT + qty);
      }
      rowsToDelete.push(i + 1);
    }
  }
  for (var k = 0; k < rowsToDelete.length; k++) {
    shL.deleteRow(rowsToDelete[k]);
  }
  return { success: true, deleted: rowsToDelete.length };
}

// ============================================
// แก้ไขจำนวนสินค้าในคลัง
// ============================================
function doUpdateStock(d) {
  var shS = SS.getSheetByName(SHEET_STOCK);
  var shT = SS.getSheetByName(SHEET_TRUCK);
  var rowS = findRow(shS, d.code);
  if (rowS < 0) return { error: 'ไม่พบรหัส ' + d.code };
  shS.getRange(rowS, 3).setValue(Number(d.qty));
  if (d.unit) shS.getRange(rowS, 4).setValue(d.unit);
  var rowT = findRow(shT, d.code);
  if (rowT > 0 && d.unit) shT.getRange(rowT, 4).setValue(d.unit);
  return { success: true };
}

// ============================================
// เพิ่มอุปกรณ์ใหม่
// ============================================
function doAddItem(d) {
  var shS = SS.getSheetByName(SHEET_STOCK);
  var shT = SS.getSheetByName(SHEET_TRUCK);
  if (findRow(shS, d.code) > 0) return { error: 'รหัส ' + d.code + ' มีอยู่แล้ว' };
  shS.appendRow([d.code, d.name, Number(d.qty), d.unit, d.cat || '']);
  shT.appendRow([d.code, d.name, 0, d.unit, d.cat || '']);
  return { success: true };
}

// ============================================
// แก้ไขจำนวนพัสดุในใบงานแก้ไฟ
// ============================================
function doUpdateJobItem(d) {
  var shT    = SS.getSheetByName(SHEET_TRUCK);
  var shL    = SS.getSheetByName(SHEET_LOGS);
  var jobId  = String(d.jobId);
  var code   = String(d.code);
  var newQty = parseFloat(d.newQty);
  var oldQty = parseFloat(d.oldQty);
  var diff   = newQty - oldQty;

  var logData = shL.getDataRange().getValues();
  var updated = 0;
  for (var i = 1; i < logData.length; i++) {
    if (String(logData[i][10]) === jobId && String(logData[i][1]) === code) {
      shL.getRange(i + 1, 4).setValue(newQty);
      updated++;
      break;
    }
  }
  if (updated === 0) return { error: 'ไม่พบรายการใน logs: ' + jobId + ' / ' + code };

  if (diff !== 0) {
    var rowT = findRow(shT, code);
    if (rowT > 0) {
      var curT = Number(shT.getRange(rowT, 3).getValue());
      shT.getRange(rowT, 3).setValue(Math.max(0, curT - diff));
    }
  }
  return { success: true, updated: updated, diff: diff };
}

// ============================================
// เพิ่มอุปกรณ์เข้าใบงานแก้ไฟเดิม (กรณีตอนตัดใส่ของไม่ครบ) — ตัดจากรถตามปกติ
// รหัสซ้ำในใบงาน → บวกจำนวนแถวเดิม, รหัสใหม่ → append แถวใหม่ jobId เดียวกัน
// ============================================
function doAddJobItem(d) {
  var shT = SS.getSheetByName(SHEET_TRUCK);
  var shL = SS.getSheetByName(SHEET_LOGS);
  var qty = Number(d.qty);
  if (!(qty > 0)) return { error: 'จำนวนไม่ถูกต้อง' };
  var jobId = String(d.jobId);
  var code  = String(d.code);

  var rowT = findRow(shT, code);
  if (rowT < 0) return { error: 'ไม่พบรหัส ' + code + ' บนรถ' };
  var curT = Number(shT.getRange(rowT, 3).getValue());
  if (curT < qty) return { error: 'ของบนรถไม่พอ: ' + d.name + ' เหลือ ' + curT };

  var data = shL.getDataRange().getValues();
  var existRow = -1, existQty = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][10]) === jobId && String(data[i][1]) === code) {
      existRow = i + 1; existQty = Number(data[i][3]); break;
    }
  }

  shT.getRange(rowT, 3).setValue(curT - qty);
  if (existRow > 0) {
    shL.getRange(existRow, 4).setValue(existQty + qty);
    return { success: true, truckQty: curT - qty, merged: true, newQty: existQty + qty };
  }
  shL.appendRow(['งานแก้ไฟ', code, d.name, qty, d.unit,
                 d.shift || '', d.location || '', nowTH(),
                 d.lat || '', d.lng || '', jobId, d.note || '', d.openedAt || '']);
  return { success: true, truckQty: curT - qty, merged: false };
}

// ============================================
// ยืนยัน/ยกเลิก "เปิดใบสั่งในระบบแล้ว"
// เก็บวันเวลาลงคอลัมน์ M (openedAt) ของทุกแถวใน jobId นั้น
// ============================================
function doToggleJobOpened(d) {
  var shL   = SS.getSheetByName(SHEET_LOGS);
  var jobId = String(d.jobId);
  var val   = d.opened ? nowTH() : '';
  var data  = shL.getDataRange().getValues();
  var found = 0;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][10]) === jobId) {      // คอลัมน์ K = jobId
      shL.getRange(i + 1, 13).setValue(val);  // คอลัมน์ M = openedAt
      found++;
    }
  }
  if (!found) return { error: 'ไม่พบใบงาน ' + jobId };
  return { success: true, openedAt: val };
}

// ============================================
// ส่งข้อความเข้ากลุ่ม LINE
// ============================================
var LINE_TOKEN = 'Ced7LLZ9IqyR72AjVYDYzZd6P1QhdYixpdOmITiEgQj9WuP0YCVWEwy1hBgckYeE+WgsTPhzjulW66r9IsdcXAYoUQHfbnbEHOoMR9igrDGjv+L3AIl9ciNHoB/a+US4OZll6Hufph4D6sqo7KtpBwdB04t89/1O/w1cDnyilFU=';

function sendLineGroup(message) {
  var groupId = PropertiesService.getScriptProperties()
                  .getProperty('LINE_GROUP_ID');
  if (!groupId) return;
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + LINE_TOKEN
    },
    payload: JSON.stringify({
      to: groupId,
      messages: [{ type: 'text', text: message }]
    }),
    muteHttpExceptions: true
  });
}

// ============================================
// ตั้งค่าหัว logs (รันครั้งแรกครั้งเดียว)
// ============================================
function initLogs() {
  var sh      = SS.getSheetByName(SHEET_LOGS);
  var headers = ['type','code','name','qty','unit','shift','location','timestamp','lat','lng','jobId','note','openedAt'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
}
function testGetGroupId() {
  // ใส่ Group ID มือถือของกลุ่มตรงๆ
  PropertiesService.getScriptProperties()
    .setProperty('LINE_GROUP_ID', 'Cc6b27fd5916712b63d8e671a954181ea');
  Logger.log('บันทึกแล้ว');
}
function testSendLine() {
  var groupId = PropertiesService.getScriptProperties()
                  .getProperty('LINE_GROUP_ID');
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + LINE_TOKEN
    },
    payload: JSON.stringify({
      to: groupId,
      messages: [{ type: 'text', text: 'ทดสอบ' }]
    }),
    muteHttpExceptions: true
  });
  Logger.log('Status: ' + response.getResponseCode());
  Logger.log('Response: ' + response.getContentText());
}
function checkGroupId() {
  var id = PropertiesService.getScriptProperties()
             .getProperty('LINE_GROUP_ID');
  Logger.log('Group ID: ' + id);
}
function checkQuota() {
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + LINE_TOKEN
    },
    muteHttpExceptions: true
  });
  Logger.log('Response: ' + response.getContentText());
}
