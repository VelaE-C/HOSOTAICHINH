// ============================================================
// duyet.js — Hộp thư chờ duyệt, gộp cả 3 loại hồ sơ, KHÔNG lọc theo dự án
// (đúng thiết kế: luôn hiện hết để không bỏ sót hồ sơ cần xử lý)
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, statusBadge, IS_MOBILE } from '../core/utils.js';
import { calcBill } from './bill.js'; // dùng chung ĐÚNG 1 công thức tính C/D/K với trang Bill — tránh lệch số giữa 2 màn hình

// Bước 1-2: hạn 2 ngày (48h). Bước 3-4: hạn 1 ngày (24h) — khớp đúng quy tắc SLA đang dùng.
function isOverdue(m) {
  const slaHours = m.step_no <= 2 ? 48 : 24;
  return m.created_at && (Date.now() - new Date(m.created_at).getTime()) / 3600000 > slaHours;
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const { data: mine, error } = await supabase
    .from('approval_assignments')
    .select('document_type, document_id, step_no, role_type, created_at')
    .eq('user_id', user.id)
    .eq('status', 'pending');

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Lỗi tải dữ liệu: ${error.message}</div>`;
    return;
  }
  if (!mine || mine.length === 0) {
    container.innerHTML = `<div class="card empty-note"><div style="font-size:30px;margin-bottom:8px">🗂️</div><div style="font-weight:600;color:var(--gray7);margin-bottom:3px">Không có hồ sơ nào chờ bạn duyệt</div><div>Quay lại sau, hoặc kiểm tra bạn đã được gán đúng vai trò/dự án chưa.</div></div>`;
    return;
  }

  // Gom theo loại hồ sơ để truy vấn 1 lần cho mỗi bảng, đỡ gọi lẻ tẻ nhiều lần
  const idsByType = { contract: [], bill: [], totrinh: [] };
  mine.forEach((m) => idsByType[m.document_type]?.push(m.document_id));

  const [contracts, bills, totrinhs] = await Promise.all([
    idsByType.contract.length
      ? supabase.from('contracts').select('id, doc_number, value, status, project_id, partners(name), projects(code)').in('id', idsByType.contract)
      : { data: [] },
    idsByType.bill.length
      ? supabase.from('bills').select('id, doc_number, period_no, val_a, val_b, val_d, val_e, val_f, val_g, val_h, val_i, vat_rate, status, project_id, partners(name), projects(code)').in('id', idsByType.bill)
      : { data: [] },
    idsByType.totrinh.length
      ? supabase.from('to_trinh_chu_truong').select('id, doc_number, title, status, project_id, projects(code)').in('id', idsByType.totrinh)
      : { data: [] },
  ]);

  const contractMap = Object.fromEntries((contracts.data || []).map((c) => [c.id, c]));
  const billMap = Object.fromEntries((bills.data || []).map((b) => [b.id, b]));
  const totrinhMap = Object.fromEntries((totrinhs.data || []).map((t) => [t.id, t]));

  const rows = mine
    .map((m) => {
      if (m.document_type === 'contract') {
        const c = contractMap[m.document_id];
        if (!c) return null;
        return { ...m, docNumber: c.doc_number, projectCode: c.projects?.code, partner: c.partners?.name, label: 'Hợp đồng', contractValue: c.value, sanLuong: null, deNghi: c.value, status: c.status };
      }
      if (m.document_type === 'bill') {
        const b = billMap[m.document_id];
        if (!b) return null;
        const { C, K } = calcBill(b);
        return { ...m, docNumber: `${b.doc_number}${b.period_no ? ` (Kỳ ${b.period_no})` : ''}`, projectCode: b.projects?.code, partner: b.partners?.name, label: 'Bill thanh toán', contractValue: C, sanLuong: b.val_d, deNghi: K, status: b.status };
      }
      const t = totrinhMap[m.document_id];
      if (!t) return null;
      return { ...m, docNumber: t.doc_number, projectCode: t.projects?.code, partner: '—', label: 'Tờ trình chủ trương', contractValue: null, sanLuong: null, deNghi: null, status: t.status };
    })
    .filter(Boolean)
    .sort((a, b) => (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0)); // trễ lên đầu

  const overdueCount = rows.filter(isOverdue).length;

  // Tách theo đúng thứ tự cố định: Hợp đồng -> Bill thanh toán -> Tờ trình chủ
  // trương — mỗi loại 1 khung riêng, cuộn riêng bên trong, không còn gộp chung 1
  // bảng dài như trước (khỏi phải lướt qua Hợp đồng mới tới được Bill).
  const byType = { contract: [], bill: [], totrinh: [] };
  rows.forEach((r) => byType[r.document_type]?.push(r));

  const CELL = 'padding:3px 8px;font-size:12px;line-height:1.3'; // dòng gọn còn ~nửa chiều cao mặc định
  function rowHtml(r) {
    // Trạng thái + "Trễ" nằm CHUNG 1 dòng (không xuống hàng) để không đội thêm
    // chiều cao dòng — khác cách làm trước đây dùng <div> tách riêng.
    const statusCell = `${statusBadge(r.status)}${isOverdue(r) ? ' <span style="color:var(--red);font-weight:700;font-size:10.5px;white-space:nowrap">⚠️ Trễ</span>' : ''}`;
    if (IS_MOBILE) {
      return `<tr class="click" data-type="${r.document_type}" data-id="${r.document_id}">
      <td style="${CELL}"><span class="badge idle">${r.projectCode || '—'}</span></td>
      <td style="${CELL}">${r.partner || '—'}</td>
      <td style="${CELL}">${statusCell}</td>
    </tr>`;
    }
    return `<tr class="click" data-type="${r.document_type}" data-id="${r.document_id}">
      <td style="${CELL}"><span class="badge idle">${r.projectCode || '—'}</span></td>
      <td class="mono" style="${CELL}">${r.docNumber}</td>
      <td style="${CELL}">${r.partner || '—'}</td>
      <td class="mono" style="${CELL}">${r.contractValue != null ? fmt(r.contractValue) : '—'}</td>
      <td class="mono" style="${CELL}">${r.sanLuong != null ? fmt(r.sanLuong) : '—'}</td>
      <td class="mono" style="${CELL}">${r.deNghi != null ? fmt(r.deNghi) : '—'}</td>
      <td style="${CELL};white-space:nowrap">${statusCell}</td>
    </tr>`;
  }

  function sectionHtml(title, items) {
    const head = IS_MOBILE
      ? `<tr><th style="${CELL}">Dự án</th><th style="${CELL}">Đối tác</th><th style="${CELL}">Trạng thái</th></tr>`
      : `<tr><th style="${CELL}">Dự án</th><th style="${CELL}">Số hồ sơ</th><th style="${CELL}">Đối tác</th><th style="${CELL}">Giá trị Hợp đồng</th><th style="${CELL}">Tổng sản lượng</th><th style="${CELL}">Đề nghị đợt này</th><th style="${CELL}">Trạng thái</th></tr>`;
    return `<div class="card" style="padding:0;overflow:hidden;margin-bottom:14px">
      <div style="padding:9px 14px;border-bottom:1px solid var(--gray1);font-weight:700;font-size:13px;display:flex;justify-content:space-between;align-items:center">
        <span>${title}</span><span class="badge idle">${items.length}</span>
      </div>
      <div style="max-height:360px;overflow-y:auto;overflow-x:auto">
        <table><thead>${head}</thead><tbody>
        ${items.length ? items.map(rowHtml).join('') : `<tr><td colspan="${IS_MOBILE ? 3 : 7}" style="text-align:center;color:var(--gray4);padding:16px">Không có hồ sơ nào</td></tr>`}
        </tbody></table>
      </div>
    </div>`;
  }

  container.innerHTML = `
    ${overdueCount ? `<div style="font-size:12.5px;background:#FEF2F2;color:var(--red);padding:9px 12px;border-radius:7px;margin-bottom:12px">⚠️ <b>${overdueCount} hồ sơ</b> đang trễ hạn duyệt — xem các dòng có nhãn đỏ bên dưới.</div>` : ''}
    ${sectionHtml('Hợp đồng', byType.contract)}
    ${sectionHtml('Bill thanh toán', byType.bill)}
    ${sectionHtml('Tờ trình chủ trương', byType.totrinh)}
  `;

  container.querySelectorAll('[data-type]').forEach((row) =>
    row.addEventListener('click', async () => {
      const type = row.dataset.type;
      const id = row.dataset.id;
      const mod = await import(`./${type === 'contract' ? 'hopdong' : type === 'bill' ? 'bill' : 'totrinh'}.js`);
      mod.openDetail(id, user, () => render(container, user));
    }),
  );
}
