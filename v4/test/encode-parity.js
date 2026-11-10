const { encodeBand, decodeBand, frame, parseResponse, bandQueryPayload, OP_GET, OP_SET, CMD_VOLUME, CMD_PEQ_BAND } = require('../ru3.js');

// APP_BLOBS copied from v2/test_dac.py (ground truth, official app captures)
const APP_BLOBS = [
  [[1, 64, 182 / 256, 0.1, 'PEAK'], 'ae1b018072f8bf009f7e3f7f72f8bf004e9a407f'],
  [[1, 64, 182 / 256, 0.2, 'PEAK'], '6237028006e0be00597b3f7f06e0be00bbb2417f'],
  [[1, 64, 182 / 256, 0.30000000000000004, 'PEAK'], '1d53038033c9bd0071763f7f33c9bd008fc9427f'],
  [[1, 63, 0.71, 0.0, 'PEAK'], 'ffffff7f0b4ebe002a40427f0b4ebe002a40427f'],
  [[9, 16000, 0.71, 0.0, 'PEAK'], 'ffffff7f88a67db0efb2041f88a67db0efb2041f'],
];
let fails = 0;
for (const [[band, freq, q, gain, ftype], appHex] of APP_BLOBS) {
  const rec = encodeBand(band, freq, q, gain, ftype);
  const mine = Buffer.from(rec.slice(4, 24));
  const app = Buffer.from(appHex, 'hex');
  let maxDiff = 0;
  for (let i = 0; i < 5; i++) {
    const a = mine.readUInt32LE(i * 4), b = app.readUInt32LE(i * 4);
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
  }
  const ok = maxDiff <= 1;
  if (!ok) fails++;
  console.log(`band=${band} f=${freq} q=${q} g=${gain} ${ftype}: maxWordDiff=${maxDiff} ${ok ? 'OK' : 'FAIL'}`);
}

// Frame parity
const volGetTx = Buffer.from(frame(OP_GET, CMD_VOLUME)).toString('hex');
console.log('VOL_GET_TX', volGetTx === '4b802300' + '00'.repeat(60) ? 'OK' : 'FAIL ' + volGetTx);
const bandQTx = Buffer.from(frame(OP_GET, CMD_PEQ_BAND, bandQueryPayload(0))).toString('hex');
console.log('BANDQ_TX', bandQTx === '4b80092109000000ffffff7f' + '00'.repeat(18) + 'c0000000000001' + '00'.repeat(27) ? 'OK' : 'FAIL ' + bandQTx);

const bandQrx = Buffer.from('4b80092109000000ffffff7fc9265f00d1fca07fc9265f00d1fca07f2000b6000000010001' + '00'.repeat(27), 'hex');
const d = decodeBand(parseResponse(bandQrx, CMD_PEQ_BAND).slice(0, 33));
console.log('BANDQ_RX decode', d.freq === 32 && Math.abs(d.q - 182 / 256) < 1e-9 && d.gain_db === 0 && d.type === 2 ? 'OK' : 'FAIL', JSON.stringify(d));

console.log(fails ? `${fails} BLOB FAILURES` : 'ALL PARITY OK');
process.exit(fails ? 1 : 0);
