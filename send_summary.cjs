const fs = require('fs');
require('dotenv').config();
const t = require('./telegram.js');

const logData = JSON.parse(fs.readFileSync('/root/meridian/decision-log.json', 'utf8'));
const decisions = logData.decisions || [];

let text = '';
if (decisions.length === 0) {
  text = 'Halo @VoxyNoxi, belum ada keputusan baru — bot tetap running normal.';
} else {
  text = 'Halo @VoxyNoxi,\n\nBerikut adalah ringkasan decision log Meridian bot:\n\n';
  text += '📊 <b>Total Keputusan:</b> ' + decisions.length + '\n';
  text += '🕐 <b>10 Keputusan Terakhir:</b>\n\n';
  
  const last10 = decisions.slice(-10).reverse();
  last10.forEach(x => {
    const ts = (x.ts || '').slice(0, 16).replace('T', ' ');
    const type = (x.type || '?').toUpperCase();
    const pool = x.pool_name || '-';
    let reason = x.reason || '';
    if (reason.length > 80) reason = reason.slice(0, 80) + '...';
    text += '• <code>[' + ts + ']</code> <b>' + type + '</b> | ' + pool + ' | ' + reason + '\n';
  });
  
  text += '\n📢 <b>Status:</b> Bot tetap running normal di VPS.';
}

t.sendHTML(text).then(res => {
  console.log('Success:', res ? 'OK' : 'Failed');
  process.exit(0);
}).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
