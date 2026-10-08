// ============================================================
// doitac.js — Đối tác (NCC/NTP). Bất kỳ vai trò nào cũng khai báo được đối tác mới
// (kể cả QS) — chống trùng theo MST, không cho xóa nếu đã dùng trong hợp đồng
// (đã có trigger chặn ở tầng database, module này chỉ ẩn nút xóa cho gọn).
//
// ⚠️ SỬA 08/10/2026 — 5 LỖI, phát hiện từ ca "NGUYỄN VĂN HẢI / mã NVH"
//
//  1. KHÔNG KIỂM TRA MÃ VIẾT TẮT. Form chỉ dò MST. Mã trùng thì tới lúc bấm Lưu
//     mới biết, và nhận nguyên câu tiếng Anh của Postgres:
//       duplicate key value violates unique constraint "partners_abbr_unique_ci"
//     (Khóa partners_abbr_unique_ci đặt ngày 19/09 để chặn trùng SỐ HỢP ĐỒNG —
//      số hợp đồng in ra từ partners.abbr. Khóa này ĐÚNG, không được gỡ.)
//
//  2. 🔴 loading(true) KHÔNG BAO GIỜ TẮT KHI LỖI. Cả hai hàm Lưu đều viết
//       loading(true); ... if (error) return toast(...);
//     -> thoát sớm, không ai gọi loading(false). Màn "Đang xử lý…" treo vĩnh viễn
//        chồng lên câu báo lỗi. Đúng cái thấy trong ảnh chụp màn hình.
//
//  3. 🔴 DÒ MST CHẠY Ở SỰ KIỆN blur VÀ CÓ await -> ĐUA NHAU. Gõ MST xong bấm Lưu
//     ngay thì blur chưa kịp trả lời, existingMatch vẫn null -> vẫn chèn mới.
//     Nay tải sẵn danh sách đối tác lúc mở form, dò tại chỗ, không còn chờ mạng.
//
//  4. KHÔNG CHẶN HTML TRONG DỮ LIỆU. Tên/địa chỉ có dấu nháy kép " thì form Sửa
//     vỡ bố cục (value="${p.name}"). Tên công ty tiếng Việt có ngoặc kép là chuyện
//     bình thường. Nay mọi chỗ đổ dữ liệu ra HTML đều đi qua esc().
//
//  5. KHÔNG CẢNH BÁO TRÙNG TÊN. Đối tác là CÁ NHÂN rất hay bị khai hai lần dưới
//     hai MST khác nhau -> lịch sử giao dịch bị chẻ đôi, khó gỡ hơn trùng mã nhiều.
//     Nay trùng tên thì cảnh báo vàng, nhưng VẪN CHO LƯU — có thể là hai người
//     trùng tên thật, máy không được quyền quyết thay người.
//
// NGUYÊN TẮC: kiểm tra ở trình duyệt chỉ để BÁO SỚM cho dễ hiểu. Chốt chặn thật
// vẫn là ràng buộc của database (danh sách tải về là ảnh chụp tại thời điểm mở
// form; người khác có thể khai thêm trong lúc mình đang gõ). Vì vậy phần dịch
// câu lỗi của Postgres sang tiếng Việt ở dưới PHẢI giữ.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, toast, loading, pushModalHistory, popModalHistory, normalizeSearchText } from '../core/utils.js';
import { calcBill } from './bill.js'; // dùng chung ĐÚNG 1 công thức tính K với trang Bill — tránh lệch số
import { exportListExcel } from './bctcExport.js'; // hàm xuất Excel dùng chung — cùng bộ màu/font với file BCTC

const PARTNER_TYPE_LABEL = { NCC: 'NCC — Nhà cung cấp', NTP: 'NTP — Nhà thầu phụ', DTC: 'ĐTC — Đội thi công', DVK: 'DVK — Dịch vụ khác' };

// Chặn dữ liệu người dùng phá vỡ HTML. Bắt buộc dùng ở MỌI chỗ đổ dữ liệu ra
// màn hình — kể cả value="..." của ô nhập, chỗ này mới là chỗ vỡ nặng nhất.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Bỏ dấu tiếng Việt để so mã viết tắt và dựng mã đề xuất.
const noAccent = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

const keyAbbr = (s) => noAccent(s).trim().toUpperCase(); // khóa so sánh mã: bỏ dấu, bỏ khoảng trắng thừa, in hoa

// Những từ chỉ loại hình doanh nghiệp — bỏ đi khi dựng mã, vì gần như công ty nào
// cũng có, giữ lại thì mã nào cũng bắt đầu bằng CTCP.
const STOP = new Set(['CONG', 'TY', 'CO', 'PHAN', 'TNHH', 'MTV', 'DNTN', 'HTX', 'CHI', 'NHANH']);

function wordsOf(name) {
  const words = noAccent(name).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return (kept.length ? kept : words).slice(0, 4);
}

const initialsOf = (name) => wordsOf(name).map((w) => w[0]).join('');

// Dựng mã còn trống: thử mã gốc -> nối thêm chữ cái của từ cuối -> cuối cùng mới
// gắn số. Gắn số là phương án chót vì số trong mã hợp đồng dễ gây hiểu nhầm.
function suggestAbbr(name, taken) {
  const base = initialsOf(name);
  if (!base) return '';
  const last = wordsOf(name).pop() || '';
  const cands = [base];
  for (let i = 1; i < Math.min(last.length, 4); i++) cands.push(base + last.slice(1, 1 + i));
  for (let n = 2; n <= 9; n++) cands.push(base + n);
  return cands.find((c) => !taken.has(c)) || '';
}

// Tải nhẹ toàn bộ đối tác để dò tại chỗ (không gọi mạng theo từng phím gõ).
// Bảng này cỡ vài trăm dòng — rẻ hơn nhiều so với mỗi lần gõ một lượt mạng.
async function loadPartnerIndex() {
  const { data, error } = await supabase.from('partners').select('id, name, abbr, mst');
  if (error) {
    console.error('[doitac.js] Không tải được danh sách đối tác để dò trùng:', error);
    return null; // null = KHÔNG BIẾT, khác hẳn với "không trùng" — xem cách dùng bên dưới
  }
  const list = data || [];
  return {
    list,
    abbrTaken: new Set(list.map((p) => keyAbbr(p.abbr)).filter(Boolean)),
    byAbbr: (a, exceptId) => (keyAbbr(a) ? list.find((p) => keyAbbr(p.abbr) === keyAbbr(a) && p.id !== exceptId) || null : null),
    byMst: (m) => list.find((p) => String(p.mst || '').trim() === String(m || '').trim()) || null,
    byName: (n, exceptId) => list.find((p) => normalizeSearchText(p.name) === normalizeSearchText(n) && p.id !== exceptId) || null,
  };
}

// Dịch câu lỗi của Postgres sang tiếng Việt. Người dùng không có nghĩa vụ hiểu
// "duplicate key value violates unique constraint".
function friendlyError(error, ctx = {}) {
  const m = String(error?.message || '');
  if (m.includes('partners_abbr_unique_ci')) {
    return `Mã viết tắt "${ctx.abbr || ''}" đã có đối tác khác dùng rồi. Mã này dùng để sinh số hợp đồng nên không được trùng — đổi sang mã khác rồi lưu lại.`;
  }
  if (m.includes('duplicate') && m.includes('mst')) {
    return `Mã số thuế "${ctx.mst || ''}" đã có trong hệ thống. Đóng form này, tìm đối tác đó trong danh sách và bổ sung thông tin vào bản ghi có sẵn.`;
  }
  if (m.includes('duplicate key')) return `Dữ liệu bị trùng với một đối tác đã có. Kiểm tra lại MST và Mã viết tắt. (Chi tiết kỹ thuật: ${m})`;
  if (m.includes('row-level security') || m.includes('permission')) return `Bạn không có quyền thực hiện thao tác này. Báo quản trị hệ thống.`;
  return 'Lỗi lưu đối tác: ' + m;
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: partners, error }, { data: contractCounts }] = await Promise.all([
    supabase.from('partners').select('id, name, abbr, mst, type').order('name'),
    supabase.from('contracts').select('partner_id'),
  ]);
  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${esc(error.message)}</div>`;
    return;
  }

  // Đếm số hợp đồng theo từng đối tác — gộp lại ở client
  const countMap = {};
  (contractCounts || []).forEach((c) => (countMap[c.partner_id] = (countMap[c.partner_id] || 0) + 1));

  // Đối tác CHƯA CÓ MÃ VIẾT TẮT: ràng buộc duy nhất không chặn được ô rỗng
  // (Postgres coi mỗi NULL là một giá trị khác nhau), nên nhóm này sẽ gây trùng
  // SỐ HỢP ĐỒNG về sau mà không có cảnh báo nào. Nêu lên để còn xử lý.
  const noAbbr = (partners || []).filter((p) => !p.abbr || !String(p.abbr).trim());

  container.innerHTML = `
    ${noAbbr.length ? `<div style="font-size:12.5px;background:#FEF3C7;color:#92400E;padding:9px 12px;border-radius:7px;margin-bottom:12px">⚠️ <b>${noAbbr.length} đối tác chưa có mã viết tắt</b> — những đối tác này sẽ gây trùng số hợp đồng khi ký. Gõ tên họ vào ô lọc, mở ra và bổ sung mã.</div>` : ''}
    <div style="display:flex;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <input type="text" class="form-input" id="nameFilter" placeholder="🔎 Lọc theo tên Đối tác..." style="max-width:320px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary" id="btnExport">📊 Xuất Excel</button>
        <button class="btn btn-primary" id="btnNew">+ Khai báo đối tác mới</button>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Đối tác</th><th>Mã viết tắt</th><th>MST</th><th>Loại</th><th>Số hợp đồng</th></tr></thead><tbody id="partnerTbody"></tbody></table></div>`;

  function renderRows(list) {
    if (!list.length) return `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Không có đối tác nào khớp bộ lọc</td></tr>`;
    return list
      .map((p) => `<tr class="click" data-id="${esc(p.id)}"><td>${esc(p.name)}</td><td>${p.abbr && String(p.abbr).trim() ? `<span class="code-chip">${esc(p.abbr)}</span>` : `<span style="color:var(--red);font-size:11.5px;font-weight:700">⚠️ thiếu mã</span>`}</td><td class="mono">${esc(p.mst)}</td>
    <td><span class="badge ${p.type === 'NCC' ? 'info' : 'done'}">${esc(p.type)}</span></td><td>${countMap[p.id] || 0}</td></tr>`)
      .join('');
  }

  function wireRowClicks() {
    container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openDetail(r.dataset.id, user, () => render(container, user))));
  }

  // Danh sách ĐANG HIỂN THỊ (sau khi lọc) — xuất Excel bám đúng cái đang thấy trên
  // màn hình, không phải lúc nào cũng xuất toàn bộ. Đang lọc "Cát Vạn Thịnh" mà bấm
  // xuất ra cả nghìn dòng thì vừa sai ý vừa khó dùng.
  let currentList = partners || [];

  container.querySelector('#partnerTbody').innerHTML = renderRows(currentList);
  wireRowClicks();

  container.querySelector('#nameFilter').addEventListener('input', (e) => {
    const q = normalizeSearchText(e.target.value);
    currentList = q ? (partners || []).filter((p) => normalizeSearchText(p.name).includes(q)) : partners || [];
    container.querySelector('#partnerTbody').innerHTML = renderRows(currentList);
    wireRowClicks();
  });

  container.querySelector('#btnNew').addEventListener('click', () => openCreateModal(user, () => render(container, user)));

  container.querySelector('#btnExport').addEventListener('click', async (e) => {
    if (!currentList.length) return toast('Không có đối tác nào để xuất', 'error');
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Đang tạo…';
    const isFiltered = currentList.length !== (partners || []).length;
    await exportListExcel(
      {
        subtitle: 'DANH SÁCH ĐỐI TÁC NTP / NCC',
        note: `Tổng cộng: ${currentList.length} đối tác${isFiltered ? ` (đã lọc từ ${(partners || []).length} đối tác)` : ''}`,
        sheetName: 'Doi tac',
        fileBase: `Danh_sach_doi_tac_${new Date().toISOString().slice(0, 10)}`,
        columns: [
          { key: 'name', header: 'ĐỐI TÁC', width: 58 },
          { key: 'abbr', header: 'MÃ VIẾT TẮT', width: 18, center: true },
          { key: 'mst', header: 'MST', width: 20, center: true },
          { key: 'type', header: 'LOẠI', width: 26 },
          { key: 'count', header: 'SỐ HỢP ĐỒNG', width: 16, num: true },
        ],
        rows: currentList.map((p) => ({
          name: p.name,
          abbr: p.abbr,
          mst: p.mst, // để dạng chữ — MST có số 0 đứng đầu, ép thành số sẽ mất số 0
          type: PARTNER_TYPE_LABEL[p.type] || p.type,
          count: countMap[p.id] || 0,
        })),
      },
      (msg) => toast('Lỗi xuất Excel: ' + msg, 'error'),
    );
    btn.disabled = false;
    btn.textContent = label;
  });
}

export async function openDetail(id, user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box" style="max-width:1200px;width:96%"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: p } = await supabase.from('partners').select('*').eq('id', id).single();
  if (!p) {
    modal.querySelector('.panel-box').innerHTML = `<div class="empty-note">Không tải được đối tác.</div>`;
    return;
  }
  const { data: contracts } = await supabase.from('contracts').select('id, doc_number, value, status, contract_type, project_id, projects(code)').eq('partner_id', id).order('created_at', { ascending: false });

  // Tổng đã lên Bill — gộp từ MỌI hợp đồng, MỌI dự án của đối tác này (không riêng
  // 1 hợp đồng như bảng "Hợp đồng đã ký" bên dưới). Bỏ bill Nháp (chưa thật sự "lên
  // bill") và bill Hủy (không tính).
  const contractIds = (contracts || []).map((c) => c.id);
  let billsByProject = {};
  let totalBillAmount = 0;
  if (contractIds.length) {
    const { data: bills } = await supabase
      .from('bills')
      .select('id, val_a, val_b, val_d, val_e, val_f, val_g, val_h, val_i, vat_rate, status, project_id, projects(code)')
      .in('contract_id', contractIds)
      .neq('status', 'draft')
      .neq('status', 'cancelled');
    (bills || []).forEach((b) => {
      const { K } = calcBill(b);
      const key = b.project_id;
      if (!billsByProject[key]) billsByProject[key] = { projectName: b.projects?.code || '—', count: 0, total: 0 };
      billsByProject[key].count += 1;
      billsByProject[key].total += K;
      totalBillAmount += K;
    });
  }
  const projectRows = Object.values(billsByProject).sort((a, b) => b.total - a.total);

  // Thanh toán (trước thuế) = bill "paid" gần nhất của TỪNG hợp đồng — y hệt công
  // thức đang dùng ở Báo cáo tài chính, không tính lại riêng.
  const latestPaidByContract = {};
  if (contractIds.length) {
    const { data: paidBills } = await supabase.from('bills').select('contract_id, period_no, val_d, vat_rate').in('contract_id', contractIds).eq('status', 'paid').order('period_no', { ascending: false });
    (paidBills || []).forEach((b) => {
      if (!latestPaidByContract[b.contract_id]) latestPaidByContract[b.contract_id] = b; // dòng đầu gặp = period_no cao nhất (đã order DESC)
    });
  }
  function contractPayment(c) {
    const b = latestPaidByContract[c.id];
    if (!b) return null;
    const vatRate = (b.vat_rate ?? 8) / 100;
    return Number(b.val_d) / (1 + vatRate);
  }

  const statusVN = { draft: 'Nháp', pending: 'Đang duyệt', active: 'Có hiệu lực', rejected: 'Từ chối', closed: 'Đã thanh lý' };
  // Sửa thông tin đối tác (đặc biệt số tài khoản/ngân hàng) chỉ dành cho QLCP&HĐ/Admin
  // — đây là thông tin nhạy cảm, sửa sai/sửa bậy có thể dẫn tới chuyển nhầm tiền.
  const isKscp = (user.roles || []).some((r) => ['Admin', 'QLCPHD_CV', 'QLCPHD_TP'].includes(r));
  const thieuMa = !p.abbr || !String(p.abbr).trim();

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${esc(p.name)}</div><div class="meta">${esc(p.type)} · Mã ${thieuMa ? '⚠️ CHƯA CÓ' : esc(p.abbr)}</div></div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${isKscp ? `<button class="btn btn-sm btn-secondary" id="btnEdit">✏️ Sửa</button>` : ''}
        <button class="panel-close" id="pClose">✕</button>
      </div></div>
    <div class="panel-body">
      ${thieuMa ? `<div style="font-size:12.5px;background:#FEF3C7;color:#92400E;padding:9px 12px;border-radius:7px;margin-bottom:14px">⚠️ Đối tác này <b>chưa có mã viết tắt</b>. Số hợp đồng sinh ra từ mã này, thiếu mã sẽ gây trùng số. ${isKscp ? 'Bấm <b>✏️ Sửa</b> để bổ sung.' : 'Báo phòng QLCP &amp; Hợp đồng bổ sung giúp.'}</div>` : ''}
      <div class="kv">
        <div class="k">Mã số thuế (MST)</div><div class="v mono">${esc(p.mst)}</div>
        <div class="k">Người đại diện</div><div class="v">${esc(p.representative) || '—'}</div>
        <div class="k">Điện thoại</div><div class="v">${esc(p.phone) || '—'}</div>
        <div class="k">Địa chỉ</div><div class="v">${esc(p.address) || '—'}</div>
        <div class="k">Ngân hàng</div><div class="v">${esc(p.bank_name) || '—'}</div>
        <div class="k">Số tài khoản</div><div class="v mono">${esc(p.bank_account) || '—'}</div>
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Tổng đã lên Bill (gộp mọi Hợp đồng, mọi Dự án)</div>
      <div class="card" style="background:var(--gray1);border:1px solid var(--gray2);padding:0;overflow:hidden;margin-bottom:14px">
        ${projectRows.length ? `<table><thead><tr><th>Dự án</th><th>Số bill</th><th>Tổng đề nghị (K)</th></tr></thead><tbody>
        ${projectRows.map((r) => `<tr><td>${esc(r.projectName)}</td><td>${r.count}</td><td class="mono">${fmt(r.total)} ₫</td></tr>`).join('')}
        </tbody><tfoot><tr style="font-weight:700"><td>Tổng cộng</td><td></td><td class="mono" style="color:var(--navy)">${fmt(totalBillAmount)} ₫</td></tr></tfoot></table>` : `<div class="empty-note">Chưa có bill nào (đã trình trở lên) từ đối tác này</div>`}
      </div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Hợp đồng và Bill (${contracts?.length || 0})</div>
      <div class="card" style="padding:0;overflow:hidden">
        ${contracts && contracts.length ? `<table><thead><tr><th>Dự án</th><th>Số hợp đồng</th><th>Loại</th><th>Giá trị</th><th>Thanh toán (trước thuế)</th><th>Trạng thái</th></tr></thead><tbody>
        ${contracts.map((c) => {
          const paid = contractPayment(c);
          return `<tr><td>${esc(c.projects?.code) || '—'}</td><td class="mono">${esc(c.doc_number)}</td><td>${esc(c.contract_type)}</td><td class="mono">${fmt(c.value)}</td><td class="mono">${paid == null ? '—' : fmt(paid)}</td><td><span class="badge idle">${esc(statusVN[c.status] || c.status)}</span></td></tr>`;
        }).join('')}
        </tbody></table>` : `<div class="empty-note">Chưa có hợp đồng nào</div>`}
      </div>
      <div style="font-size:11.5px;color:var(--gray4);margin-top:8px">🔒 Đối tác đã dùng trong ít nhất 1 hợp đồng thì không thể xóa khỏi hệ thống.</div>
    </div>`;
  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));
  box.querySelector('#btnEdit')?.addEventListener('click', () => openEditModal(p, onClose));
}

async function openCreateModal(user, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Khai báo đối tác mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Nếu MST đã tồn tại trong hệ thống (dù do ai khai báo, dự án nào), hệ thống tự dùng lại đối tác đó — không tạo bản ghi trùng.</div>
      <div style="margin-bottom:13px"><label class="form-label">Mã số thuế (MST) *</label>
        <input type="text" id="fMst" class="form-input" placeholder="VD: 0301234567">
        <div id="mstCheckMsg" style="font-size:12px;margin-top:5px"></div></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên đối tác * (tự động in hoa)</label>
        <input type="text" id="fName" class="form-input">
        <div id="nameCheckMsg" style="font-size:12px;margin-top:5px"></div></div>
      <div style="margin-bottom:13px"><label class="form-label">Mã viết tắt * (dùng trong số hợp đồng)</label>
        <input type="text" id="fAbbr" class="form-input" placeholder="VD: DongA">
        <div id="abbrCheckMsg" style="font-size:12px;margin-top:5px"></div></div>
      <div style="margin-bottom:13px"><label class="form-label">Loại *</label>
        <select id="fType" class="form-input"><option value="NCC">NCC — Nhà cung cấp</option><option value="NTP">NTP — Nhà thầu phụ</option><option value="DTC">ĐTC — Đội thi công</option><option value="DVK">DVK — Dịch vụ khác</option></select></div>
      <div style="margin-bottom:13px"><label class="form-label">Người đại diện</label><input type="text" id="fRep" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Điện thoại</label><input type="text" id="fPhone" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Địa chỉ</label><input type="text" id="fAddress" class="form-input"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Ngân hàng</label><input type="text" id="fBankName" class="form-input" placeholder="VD: Techcombank"></div>
        <div><label class="form-label">Số tài khoản</label><input type="text" id="fBank" class="form-input"></div>
      </div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu đối tác</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  const elMst = modal.querySelector('#fMst');
  const elName = modal.querySelector('#fName');
  const elAbbr = modal.querySelector('#fAbbr');
  const msgMst = modal.querySelector('#mstCheckMsg');
  const msgName = modal.querySelector('#nameCheckMsg');
  const msgAbbr = modal.querySelector('#abbrCheckMsg');

  const OK = (t) => `<span style="color:var(--green)">✓ ${t}</span>`;
  const WARN = (t) => `<span style="color:var(--amber)">⚠️ ${t}</span>`;
  const BAD = (t) => `<span style="color:var(--red);font-weight:600">✕ ${t}</span>`;

  // Tải danh sách đối tác MỘT LẦN lúc mở form -> dò tại chỗ theo từng phím gõ,
  // không gọi mạng. Cũng xóa luôn chuyện đua nhau của bản cũ (dò ở blur, có await,
  // bấm Lưu nhanh thì chưa kịp trả lời).
  let existingMatch = null;
  msgMst.innerHTML = `<span style="color:var(--gray4)">Đang tải danh sách đối tác để dò trùng…</span>`;
  const idx = await loadPartnerIndex();
  msgMst.innerHTML = idx ? '' : WARN('Không tải được danh sách để dò trùng — vẫn lưu được, nhưng chỉ biết trùng khi bấm Lưu.');

  function checkMst() {
    existingMatch = null;
    if (!idx) return;
    const mst = elMst.value.trim();
    if (!mst) return (msgMst.innerHTML = '');
    const hit = idx.byMst(mst);
    if (hit) {
      existingMatch = hit;
      msgMst.innerHTML = WARN(`MST này đã có: <b>${esc(hit.name)}</b> (${esc(hit.abbr) || 'chưa có mã'}) — bấm Lưu sẽ dùng lại đối tác này, không tạo mới.`);
    } else {
      msgMst.innerHTML = OK('MST chưa tồn tại, sẽ tạo đối tác mới.');
    }
  }

  function checkAbbr() {
    if (!idx) return;
    const abbr = elAbbr.value.trim();
    if (!abbr) return (msgAbbr.innerHTML = '');
    const hit = idx.byAbbr(abbr);
    if (hit) {
      const goiY = suggestAbbr(elName.value || abbr, idx.abbrTaken);
      msgAbbr.innerHTML = BAD(`Mã <b>${esc(abbr)}</b> đã thuộc về <b>${esc(hit.name)}</b>. Mã này sinh ra số hợp đồng nên không được trùng.${goiY ? ` Gợi ý còn trống: <b>${esc(goiY)}</b>` : ''}`);
    } else {
      msgAbbr.innerHTML = OK('Mã viết tắt còn trống, dùng được.');
    }
  }

  // Trùng tên KHÔNG chặn lưu — có thể là hai người trùng tên thật. Chỉ cảnh báo,
  // vì khai một người thành hai bản ghi sẽ chẻ đôi lịch sử giao dịch, gỡ khó hơn
  // trùng mã nhiều.
  function checkName() {
    if (!idx) return;
    const name = elName.value.trim();
    if (!name) return (msgName.innerHTML = '');
    const hit = idx.byName(name);
    msgName.innerHTML = hit
      ? WARN(`Đã có đối tác tên y hệt: <b>${esc(hit.name)}</b> (MST ${esc(hit.mst) || '—'}). Kiểm tra có phải cùng một bên không — nếu phải thì đóng form này và sửa bản ghi đó, đừng khai mới.`)
      : '';
  }

  let abbrTouched = false;
  elAbbr.addEventListener('input', () => {
    abbrTouched = true;
    checkAbbr();
  });

  // Tự động in hoa NGAY LÚC GÕ (không phải chỉ hiển thị) — giữ đúng vị trí con trỏ
  // để không bị nhảy lung tung khi đang gõ dở giữa chừng.
  elName.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
    // Chỉ điền hộ mã khi người dùng CHƯA tự gõ mã — không bao giờ ghi đè chữ họ gõ.
    if (!abbrTouched && idx) {
      elAbbr.value = suggestAbbr(e.target.value, idx.abbrTaken);
      checkAbbr();
    }
  });
  elName.addEventListener('blur', checkName);
  elMst.addEventListener('input', checkMst);

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    checkMst(); // chốt lại tại thời điểm bấm Lưu, không tin vào kết quả cũ
    if (existingMatch) {
      toast(`Đã dùng lại đối tác có sẵn: ${existingMatch.name}`, 'info');
      return closeModal(modal, onClose);
    }
    const mst = elMst.value.trim();
    const name = elName.value.trim();
    const abbr = elAbbr.value.trim();
    const type = modal.querySelector('#fType').value;
    if (!mst || !name || !abbr) return toast('Điền đủ MST, Tên, Mã viết tắt', 'error');

    // Chặn sớm cho dễ hiểu. Chốt chặn thật vẫn là ràng buộc của database bên dưới.
    if (idx) {
      const clash = idx.byAbbr(abbr);
      if (clash) {
        checkAbbr();
        elAbbr.focus();
        return toast(`Mã viết tắt "${abbr}" đã thuộc về ${clash.name}. Đổi mã khác.`, 'error');
      }
    }

    loading(true);
    const { error } = await supabase.from('partners').insert({
      mst, name, abbr, type,
      representative: modal.querySelector('#fRep').value.trim() || null,
      phone: modal.querySelector('#fPhone').value.trim() || null,
      address: modal.querySelector('#fAddress').value.trim() || null,
      bank_name: modal.querySelector('#fBankName').value.trim() || null,
      bank_account: modal.querySelector('#fBank').value.trim() || null,
      created_by: user.id,
    });
    loading(false); // ⚠️ BẮT BUỘC đứng TRƯỚC mọi lệnh return — bản cũ quên, màn "Đang xử lý…" treo luôn
    if (error) return toast(friendlyError(error, { abbr, mst }), 'error');
    toast('Đã lưu đối tác mới', 'success');
    closeModal(modal, onClose);
  });
}

async function openEditModal(p, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Sửa đối tác — ${esc(p.name)}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã số thuế (MST) — không sửa được</label><input type="text" class="form-input" value="${esc(p.mst)}" disabled style="background:var(--gray1)"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên đối tác * (tự động in hoa)</label><input type="text" id="fName" class="form-input" value="${esc(p.name)}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Mã viết tắt * (dùng trong số hợp đồng)</label>
        <input type="text" id="fAbbr" class="form-input" value="${esc(p.abbr)}">
        <div id="abbrCheckMsg" style="font-size:12px;margin-top:5px"></div></div>
      <div style="margin-bottom:13px"><label class="form-label">Loại *</label>
        <select id="fType" class="form-input">
          <option value="NCC" ${p.type === 'NCC' ? 'selected' : ''}>NCC — Nhà cung cấp</option>
          <option value="NTP" ${p.type === 'NTP' ? 'selected' : ''}>NTP — Nhà thầu phụ</option>
          <option value="DTC" ${p.type === 'DTC' ? 'selected' : ''}>ĐTC — Đội thi công</option>
          <option value="DVK" ${p.type === 'DVK' ? 'selected' : ''}>DVK — Dịch vụ khác</option>
        </select></div>
      <div style="margin-bottom:13px"><label class="form-label">Người đại diện</label><input type="text" id="fRep" class="form-input" value="${esc(p.representative)}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Điện thoại</label><input type="text" id="fPhone" class="form-input" value="${esc(p.phone)}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Địa chỉ</label><input type="text" id="fAddress" class="form-input" value="${esc(p.address)}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Ngân hàng</label><input type="text" id="fBankName" class="form-input" value="${esc(p.bank_name)}" placeholder="VD: Techcombank"></div>
        <div><label class="form-label">Số tài khoản</label><input type="text" id="fBank" class="form-input" value="${esc(p.bank_account)}"></div>
      </div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  const elName = modal.querySelector('#fName');
  const elAbbr = modal.querySelector('#fAbbr');
  const msgAbbr = modal.querySelector('#abbrCheckMsg');

  // Dò trùng mã ở form Sửa luôn — đổi mã thành mã người khác đang giữ cũng dính
  // đúng ràng buộc partners_abbr_unique_ci như lúc tạo mới.
  const idx = await loadPartnerIndex();

  function checkAbbr() {
    if (!idx) return;
    const abbr = elAbbr.value.trim();
    if (!abbr) return (msgAbbr.innerHTML = `<span style="color:var(--red);font-weight:600">✕ Thiếu mã viết tắt — số hợp đồng sinh ra từ mã này.</span>`);
    const hit = idx.byAbbr(abbr, p.id); // loại chính mình ra, không thì tự báo trùng với bản thân
    if (hit) {
      const goiY = suggestAbbr(elName.value || abbr, idx.abbrTaken);
      msgAbbr.innerHTML = `<span style="color:var(--red);font-weight:600">✕ Mã <b>${esc(abbr)}</b> đã thuộc về <b>${esc(hit.name)}</b>.${goiY ? ` Gợi ý còn trống: <b>${esc(goiY)}</b>` : ''}</span>`;
    } else {
      msgAbbr.innerHTML = `<span style="color:var(--green)">✓ Mã viết tắt dùng được.</span>`;
    }
  }
  elAbbr.addEventListener('input', checkAbbr);
  checkAbbr();

  elName.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = elName.value.trim();
    const abbr = elAbbr.value.trim();
    if (!name || !abbr) return toast('Điền đủ Tên, Mã viết tắt', 'error');

    if (idx) {
      const clash = idx.byAbbr(abbr, p.id);
      if (clash) {
        checkAbbr();
        elAbbr.focus();
        return toast(`Mã viết tắt "${abbr}" đã thuộc về ${clash.name}. Đổi mã khác.`, 'error');
      }
    }

    loading(true);
    const { error } = await supabase.from('partners').update({
      name, abbr,
      type: modal.querySelector('#fType').value,
      representative: modal.querySelector('#fRep').value.trim() || null,
      phone: modal.querySelector('#fPhone').value.trim() || null,
      address: modal.querySelector('#fAddress').value.trim() || null,
      bank_name: modal.querySelector('#fBankName').value.trim() || null,
      bank_account: modal.querySelector('#fBank').value.trim() || null,
    }).eq('id', p.id);
    loading(false); // ⚠️ BẮT BUỘC đứng TRƯỚC mọi lệnh return — xem ghi chú ở form tạo mới
    if (error) return toast(friendlyError(error, { abbr, mst: p.mst }), 'error');
    toast('Đã lưu thay đổi', 'success');
    closeModal(modal, onClose);
  });
}

function ensureModal() {
  let modal = document.getElementById('module-overlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'module-overlay';
    modal.className = 'overlay';
    modal.innerHTML = `<div class="panel-box"></div>`;
    document.body.appendChild(modal);
  }
  return modal;
}
function showModal(modal, onClose) {
  modal.classList.add('show');
  modal.scrollTop = 0; // đưa về đúng đầu trang — phòng trình duyệt di động giữ vị trí cuộn cũ
  pushModalHistory();
  // Cố tình KHÔNG đóng khi bấm ra ngoài — tránh mất dữ liệu đang nhập nếu lỡ tay bấm trượt.
  // Chỉ đóng bằng nút X (hoặc nút Hủy/nút quay lại chi tiết).
}
function closeModal(modal, onClose) {
  modal.classList.remove('show');
  popModalHistory();
  if (onClose) onClose();
}
