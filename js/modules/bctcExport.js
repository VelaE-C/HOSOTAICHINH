// ============================================================
// bctcExport.js — Xuất Báo cáo tài chính ra Excel (.xlsx) và PDF
//
// Bố cục/màu/font bám theo đúng file mẫu giấy của công ty (BCTC MẪU.xlsx):
//   - Font Arial toàn bộ: tiêu đề 16 đỏ, "DỰ ÁN" 14 xanh dương, header cột 12 đậm, nội dung 10
//   - Header cột nền cam #E36C0A, dòng Hàng A/B nền xanh lá nhạt #E2EFDA,
//     dòng nhóm B.x nền xanh dương nhạt #DDEBF7
//   - Ô Ghi chú có chữ "Hoàn thành" tô vàng, cột % CÒN LẠI tô thang vàng -> cam
//   - Khối phải (Quyết toán / Thanh toán / Sản lượng còn lại / %) tách bằng 1 cột trống hẹp
//
// Module này CỐ TÌNH không import gì từ bctc.js — nó chỉ nhận vào "model" đã tính
// sẵn (xem buildExportModel bên bctc.js). Nhờ vậy không có nạp vòng giữa 2 file, và
// muốn đổi cách tính số liệu thì chỉ sửa 1 chỗ duy nhất bên bctc.js.
// ============================================================

const EXCELJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const LOGO_URL = 'https://raw.githubusercontent.com/VelaE-C/HOSOTAICHINH/refs/heads/main/LOGO%20DUNG.JPEG.png';

// Bảng màu lấy đúng từ file mẫu
const C = {
  header: 'FFE36C0A',   // cam — dòng tiêu đề cột
  section: 'FFE2EFDA',  // xanh lá nhạt — Hàng A / Hàng B
  group: 'FFDDEBF7',    // xanh dương nhạt — nhóm B.1, B.2...
  totalBox: 'FFF2F2F2', // xám nhạt — khối tổng cuối bảng
  done: 'FFFFFF00',     // vàng — ghi chú "Hoàn thành"
  titleRed: 'FFFF0000',
  titleBlue: 'FF0000CC',
  border: 'FF808080',
};

// Định dạng kế toán y như file mẫu: số 0 hiện thành dấu "-" cho dễ đọc
const NUM_FMT = '_-* #,##0_-;-* #,##0_-;_-* "-"??_-;_-@_-';
const PCT_FMT = '0.00%';

const COLUMNS = [
  { key: 'stt', header: 'STT', width: 10.7 },
  { key: 'name', header: 'TÊN HẠNG MỤC CÔNG VIỆC', width: 45 },
  { key: 'partner', header: 'TÊN NHÀ THẦU PHỤ/ NHÀ CUNG CẤP/ ĐƠN VỊ THỰC HIỆN', width: 52 },
  { key: 'forecast', header: 'GIÁ TRỊ DỰ TRÙ - \nHỢP ĐỒNG/PLHĐ', width: 22, num: true },
  { key: 'contractValue', header: 'GT HỢP ĐỒNG\nĐÃ KÝ', width: 22, num: true },
  { key: 'docNumber', header: 'SỐ HỢP ĐỒNG', width: 26 },
  { key: 'signedDate', header: 'NGÀY KÝ\nHỢP ĐỒNG', width: 15 },
  { key: 'note', header: 'GHI CHÚ', width: 18 },
  { key: 'spacer', header: '', width: 3.5, spacer: true },
  { key: 'settlement', header: 'DỮ LIỆU\nQUYẾT TOÁN', width: 19.7, num: true },
  { key: 'payment', header: 'DỮ LIỆU\nTHANH TOÁN', width: 19.7, num: true },
  { key: 'remaining', header: 'SẢN LƯỢNG\nCÒN LẠI', width: 17.8, num: true },
  { key: 'pct', header: '%\nCÒN LẠI', width: 10, pct: true },
];
const NCOL = COLUMNS.length;
const SPACER_IDX = COLUMNS.findIndex((c) => c.spacer) + 1; // 1-based cho ExcelJS

// Thang màu cột "% CÒN LẠI": 0% vàng -> 100% cam, giống conditional formatting của mẫu
function pctColor(p) {
  const t = Math.max(0, Math.min(1, Number(p) || 0));
  const g = Math.round(255 + (166 - 255) * t);
  return { hex: 'FF' + 'FF' + g.toString(16).padStart(2, '0').toUpperCase() + '00', css: `rgb(255,${g},0)` };
}

const isDone = (note) => /hoàn\s*thành/i.test(String(note || ''));
const nowLabel = () => {
  const d = new Date();
  return `Tháng ${String(d.getMonth() + 1).padStart(2, '0')} Năm ${d.getFullYear()}`;
};

// ============================================================
// EXCEL
// ============================================================
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS_CDN;
    s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('Thư viện Excel tải về nhưng không dùng được')));
    s.onerror = () => reject(new Error('Không tải được thư viện Excel — kiểm tra kết nối mạng rồi thử lại'));
    document.head.appendChild(s);
  });
}

function thinBorder() {
  const e = { style: 'thin', color: { argb: C.border } };
  return { top: e, left: e, bottom: e, right: e };
}

export async function exportBctcExcel(model, onError) {
  try {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    wb.creator = 'VELA Hồ Sơ TC';
    wb.created = new Date();
    const ws = wb.addWorksheet(model.sheetName || 'BCTC', {
      views: [{ state: 'frozen', ySplit: 8 }],
      pageSetup: { paperSize: 8, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '8:8', margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    });

    ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

    const lastCol = ws.getColumn(NCOL).letter;
    const bigTitle = (row, text, size, color, height) => {
      ws.mergeCells(`A${row}:${lastCol}${row}`);
      const cell = ws.getCell(`A${row}`);
      cell.value = text;
      cell.font = { name: 'Arial', size, bold: true, color: { argb: color } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      ws.getRow(row).height = height;
    };

    bigTitle(1, model.company || 'CÔNG TY CỔ PHẦN KỸ THUẬT XÂY DỰNG VELA', 16, C.titleRed, 46.5);
    ws.getRow(2).height = 8;
    bigTitle(3, 'BÁO CÁO TÀI CHÍNH ĐỊNH KỲ', 16, C.titleRed, 27);
    bigTitle(4, `DỰ ÁN: ${model.projectName || '—'}`, 14, C.titleBlue, 27);
    bigTitle(5, `Thời gian cập nhật: ${model.updatedLabel || nowLabel()}`, 14, 'FF000000', 27);

    // Dòng 6: số hồ sơ + ghi chú của Rev — thông tin nhận dạng, chữ nhỏ, không chen vào tiêu đề
    ws.mergeCells(`A6:${lastCol}6`);
    const sub = ws.getCell('A6');
    sub.value = [model.docNumber, model.note].filter(Boolean).join('   •   ');
    sub.font = { name: 'Arial', size: 10, italic: true, color: { argb: 'FF595959' } };
    sub.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(6).height = 18;
    ws.getRow(7).height = 10;

    // Logo — bỏ qua không báo lỗi nếu tải ảnh thất bại, bảng vẫn xuất bình thường
    try {
      const res = await fetch(LOGO_URL);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const imgId = wb.addImage({ buffer: buf, extension: 'png' });
        ws.addImage(imgId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 132, height: 40 } });
      }
    } catch (_) { /* không có logo cũng không sao */ }

    // ---- Header cột ----
    const headerRow = ws.getRow(8);
    COLUMNS.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      if (c.spacer) return;
      cell.value = c.header;
      cell.font = { name: 'Arial', size: 12, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.header } };
      cell.border = thinBorder();
    });
    headerRow.height = 57;

    // ---- Dữ liệu ----
    let r = 9;
    model.rows.forEach((row) => {
      const excelRow = ws.getRow(r);
      const isSection = row.kind === 'section';
      const isGroup = row.kind === 'group';
      const fillColor = isSection ? C.section : isGroup ? C.group : null;

      COLUMNS.forEach((c, i) => {
        const cell = excelRow.getCell(i + 1);
        if (c.spacer) return;
        let v = row[c.key];
        if (c.num) v = v == null ? null : Number(v);
        cell.value = v === '' || v == null ? null : v;
        cell.font = { name: 'Arial', size: 10, bold: isSection || isGroup };
        cell.border = thinBorder();
        cell.alignment = {
          vertical: 'middle',
          wrapText: c.key === 'name' || c.key === 'partner',
          horizontal: c.key === 'stt' || c.key === 'signedDate' || c.pct ? 'center' : c.num ? 'right' : 'left',
        };
        if (c.num) cell.numFmt = NUM_FMT;
        if (c.pct) cell.numFmt = PCT_FMT;
        if (fillColor) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        // Ghi chú "Hoàn thành" và cột % chỉ tô màu ở dòng chi tiết — dòng tổng để nguyên nền nhóm
        if (!fillColor && c.key === 'note' && isDone(v)) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.done } };
        }
        if (!fillColor && c.pct && v != null) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pctColor(v).hex } };
        }
      });
      excelRow.height = row.kind === 'item' ? 22.7 : 24;
      r += 1;
    });

    // ---- Khối tổng cuối bảng ----
    r += 1;
    const totalLine = (label, value, opts = {}) => {
      ws.mergeCells(`A${r}:C${r}`);
      const lab = ws.getCell(`A${r}`);
      lab.value = label;
      lab.font = { name: 'Arial', size: opts.big ? 12 : 11, bold: true };
      lab.alignment = { horizontal: 'right', vertical: 'middle' };
      lab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.totalBox } };
      lab.border = thinBorder();
      const val = ws.getCell(r, 4);
      val.value = typeof value === 'number' ? value : value;
      val.numFmt = opts.pct ? PCT_FMT : NUM_FMT;
      val.font = { name: 'Arial', size: opts.big ? 12 : 11, bold: true, color: { argb: opts.big ? 'FF1D4ED8' : 'FF000000' } };
      val.alignment = { horizontal: 'right', vertical: 'middle' };
      val.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.totalBox } };
      val.border = thinBorder();
      ws.getRow(r).height = 22;
      r += 1;
    };
    totalLine('Tổng Hàng A (Doanh thu)', model.totals.totalA);
    totalLine('Tổng Hàng B (Chi phí)', model.totals.totalB);
    totalLine('Hàng C — Lợi nhuận (A-B)', model.totals.totalC, { big: true });
    totalLine('Tỷ suất lợi nhuận', model.totals.margin, { pct: true });

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeFileName(model.fileBase)}.xlsx`);
  } catch (err) {
    if (onError) onError(err.message || String(err));
    else throw err;
  }
}

// ============================================================
// XUẤT EXCEL DÙNG CHUNG cho các bảng danh sách (Đối tác, Hợp đồng, Bill, Tờ trình...)
//
// Dùng lại đúng bộ màu / font / khung viền của file BCTC mẫu, để mọi file xuất ra
// từ hệ thống nhìn thống nhất như nhau. Muốn thêm nút Xuất Excel cho một trang
// danh sách khác thì chỉ cần gọi hàm này, không phải viết lại định dạng.
//
//   exportListExcel({
//     subtitle: 'DANH SÁCH ĐỐI TÁC',
//     columns : [{ key:'name', header:'ĐỐI TÁC', width:55 }, { key:'n', header:'SỐ HĐ', width:14, num:true }],
//     rows    : [{ name:'CÔNG TY A', n: 3 }, ...],
//     fileBase: 'Danh_sach_doi_tac',
//   }, (msg) => toast(msg, 'error'));
//
// withIndex (mặc định bật): tự chèn cột STT đánh số 1,2,3... ở đầu bảng.
// ============================================================
export async function exportListExcel(opts, onError) {
  const { subtitle = 'DANH SÁCH', note = '', columns = [], rows = [], fileBase = 'Danh_sach', sheetName = 'Danh sách', withIndex = true } = opts || {};
  try {
    const ExcelJS = await loadExcelJS();
    const cols = withIndex ? [{ key: '__stt', header: 'STT', width: 8, center: true }, ...columns] : columns;
    const n = cols.length;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'VELA Hồ Sơ TC';
    wb.created = new Date();
    const ws = wb.addWorksheet(sheetName, {
      views: [{ state: 'frozen', ySplit: 8 }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '8:8', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    });
    ws.columns = cols.map((c) => ({ key: c.key, width: c.width || 18 }));

    const lastCol = ws.getColumn(n).letter;
    const bigTitle = (row, text, size, color, height, italic) => {
      ws.mergeCells(`A${row}:${lastCol}${row}`);
      const cell = ws.getCell(`A${row}`);
      cell.value = text;
      cell.font = { name: 'Arial', size, bold: !italic, italic: !!italic, color: { argb: color } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      ws.getRow(row).height = height;
    };

    bigTitle(1, 'CÔNG TY CỔ PHẦN KỸ THUẬT XÂY DỰNG VELA', 16, C.titleRed, 46.5);
    ws.getRow(2).height = 8;
    bigTitle(3, subtitle, 16, C.titleRed, 27);
    bigTitle(4, `Thời gian xuất: ${nowLabel()}`, 13, 'FF000000', 24);
    bigTitle(5, note || `Tổng cộng: ${rows.length} dòng`, 10, 'FF595959', 18, true);
    ws.getRow(6).height = 8;
    ws.getRow(7).height = 10;

    try {
      const res = await fetch(LOGO_URL);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const imgId = wb.addImage({ buffer: buf, extension: 'png' });
        ws.addImage(imgId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 132, height: 40 } });
      }
    } catch (_) { /* không có logo cũng không sao */ }

    const headerRow = ws.getRow(8);
    cols.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = c.header;
      cell.font = { name: 'Arial', size: 12, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.header } };
      cell.border = thinBorder();
    });
    headerRow.height = 40;

    rows.forEach((row, idx) => {
      const excelRow = ws.getRow(9 + idx);
      cols.forEach((c, i) => {
        const cell = excelRow.getCell(i + 1);
        const v = c.key === '__stt' ? idx + 1 : row[c.key];
        cell.value = v === '' || v == null ? null : c.num ? Number(v) : v;
        cell.font = { name: 'Arial', size: 10 };
        cell.border = thinBorder();
        cell.alignment = {
          vertical: 'middle',
          wrapText: !c.num && !c.center,
          horizontal: c.center || c.key === '__stt' ? 'center' : c.num ? 'right' : 'left',
        };
        if (c.num) cell.numFmt = NUM_FMT;
      });
      excelRow.height = 22;
    });

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${safeFileName(fileBase)}.xlsx`);
  } catch (err) {
    if (onError) onError(err.message || String(err));
    else throw err;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeFileName(s) {
  return String(s || 'BCTC').replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
}

// ============================================================
// PDF — dùng hộp thoại In của trình duyệt ("Lưu thành PDF")
// Cố tình KHÔNG dùng thư viện tạo PDF trực tiếp: các thư viện đó cần nhúng font
// tiếng Việt riêng rất phức tạp, thiếu font là mất dấu toàn bộ. In từ trình duyệt
// dùng đúng font hệ thống nên chắc chắn đúng dấu 100%.
// ============================================================
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const money = (v) => (v == null || v === '' ? '' : Number(v) === 0 ? '-' : Number(v).toLocaleString('vi-VN'));
const pctText = (v) => (v == null ? '' : (Number(v) * 100).toFixed(2) + '%');

export function exportBctcPdf(model, onError) {
  const w = window.open('', '_blank');
  if (!w) {
    const msg = 'Trình duyệt đang chặn cửa sổ bật lên — cho phép popup cho trang này rồi bấm lại.';
    if (onError) return onError(msg);
    throw new Error(msg);
  }

  const headCells = COLUMNS.map((c) => (c.spacer ? `<th class="sp"></th>` : `<th${c.num || c.pct ? ' class="r"' : ''}>${esc(c.header).replace(/\n/g, '<br>')}</th>`)).join('');

  const bodyRows = model.rows
    .map((row) => {
      const cls = row.kind === 'section' ? ' class="sec"' : row.kind === 'group' ? ' class="grp"' : '';
      const tds = COLUMNS.map((c) => {
        if (c.spacer) return '<td class="sp"></td>';
        const v = row[c.key];
        if (c.num) return `<td class="r">${money(v)}</td>`;
        if (c.pct) {
          if (v == null) return '<td></td>';
          return `<td class="c" style="background:${pctColor(v).css}">${pctText(v)}</td>`;
        }
        const done = c.key === 'note' && row.kind === 'item' && isDone(v);
        const align = c.key === 'stt' || c.key === 'signedDate' ? ' class="c"' : '';
        return `<td${align}${done ? ' style="background:#FFFF00;font-weight:600"' : ''}>${esc(v)}</td>`;
      }).join('');
      return `<tr${cls}>${tds}</tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(model.fileBase)}</title>
  <style>
    @page { size: A3 landscape; margin: 8mm; }
    body { font-family: Arial, sans-serif; color:#000; padding:10px; }
    .no-print { margin-bottom:14px }
    @media print { .no-print { display:none } }
    .logo { height:44px; margin-bottom:6px; display:block }
    h1 { font-size:17px; color:#FF0000; text-align:center; margin:2px 0 }
    h2 { font-size:15px; color:#FF0000; text-align:center; margin:8px 0 2px }
    .proj { font-size:14px; color:#0000CC; font-weight:700; text-align:center; margin:4px 0 }
    .upd { font-size:13px; font-weight:700; text-align:center; margin:2px 0 }
    .sub { font-size:11px; font-style:italic; color:#595959; text-align:center; margin:4px 0 10px }
    table { width:100%; border-collapse:collapse; table-layout:fixed }
    th, td { border:1px solid #808080; padding:3px 5px; font-size:9px; vertical-align:middle; word-wrap:break-word }
    thead th { background:#E36C0A; font-size:9.5px; font-weight:700; text-align:center; }
    thead { display:table-header-group }
    tr { page-break-inside:avoid }
    td.r, th.r { text-align:right; white-space:nowrap }
    td.c { text-align:center }
    .sec > td { background:#E2EFDA; font-weight:700 }
    .grp > td { background:#DDEBF7; font-weight:700 }
    .sp { border:none !important; background:#fff !important; width:10px }
    .totals { margin-top:14px; width:auto; float:right }
    .totals td { font-size:11px; padding:4px 12px; background:#F2F2F2; font-weight:700 }
    .totals td.v { text-align:right; white-space:nowrap }
    .totals tr.big td { font-size:12.5px; color:#1D4ED8 }
    ${COLUMNS.map((c, i) => `col.c${i}{width:${c.width * 7.2}px}`).join('')}
  </style></head>
  <body>
    <div class="no-print"><button onclick="window.print()" style="padding:8px 16px;font-size:13px">🖨️ In / Lưu thành PDF</button>
      <span style="font-size:12px;color:#555;margin-left:10px">Trong hộp thoại in, chọn máy in là <b>"Lưu thành PDF"</b>, khổ giấy <b>A3 ngang</b>.</span></div>
    <img class="logo" src="${LOGO_URL}" alt="VELA" onerror="this.style.display='none'">
    <h1>${esc(model.company || 'CÔNG TY CỔ PHẦN KỸ THUẬT XÂY DỰNG VELA')}</h1>
    <h2>BÁO CÁO TÀI CHÍNH ĐỊNH KỲ</h2>
    <div class="proj">DỰ ÁN: ${esc(model.projectName || '—')}</div>
    <div class="upd">Thời gian cập nhật: ${esc(model.updatedLabel || nowLabel())}</div>
    <div class="sub">${[model.docNumber, model.note].filter(Boolean).map(esc).join('   •   ')}</div>
    <table>
      <colgroup>${COLUMNS.map((c, i) => `<col class="c${i}">`).join('')}</colgroup>
      <thead><tr>${headCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
    <table class="totals">
      <tr><td>Tổng Hàng A (Doanh thu)</td><td class="v">${money(model.totals.totalA)} ₫</td></tr>
      <tr><td>Tổng Hàng B (Chi phí)</td><td class="v">${money(model.totals.totalB)} ₫</td></tr>
      <tr class="big"><td>Hàng C — Lợi nhuận (A-B)</td><td class="v">${money(model.totals.totalC)} ₫</td></tr>
      <tr><td>Tỷ suất lợi nhuận</td><td class="v">${pctText(model.totals.margin)}</td></tr>
    </table>
  </body></html>`;

  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 600);
}
