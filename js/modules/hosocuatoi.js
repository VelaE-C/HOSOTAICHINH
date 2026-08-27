// ============================================================
// hosocuatoi.js — Hồ sơ CHÍNH MÌNH đã trình, gộp cả 3 loại, sắp xếp ưu
// tiên: Bị từ chối trước tiên (cần sửa & trình lại), rồi tới Đang duyệt
// đã trễ hạn (cần nhắc), Đang duyệt bình thường, Nháp, cuối cùng Hoàn tất.
// ============================================================
import { supabase } from '../core/config.js';
import { fmt, statusBadge } from '../core/utils.js';

// Khớp đúng quy tắc SLA đang dùng ở nơi khác: Bước 1-2 hạn 48h, Bước 3-4 hạn 24h
function isOverdue(doc) {
  if (doc.status !== 'pending' || !doc.stepCreatedAt) return false;
  const slaHours = doc.current_step <= 2 ? 48 : 24;
  return (Date.now() - new Date(doc.stepCreatedAt).getTime()) / 3600000 > slaHours;
}

// Thứ tự ưu tiên: 0 = bị từ chối, 1 = đang duyệt trễ, 2 = đang duyệt bình thường,
// 3 = nháp, 4 = hoàn tất/đã hủy
function priority(doc) {
  if (doc.status === 'rejected') return 0;
  if (doc.status === 'pending') return isOverdue(doc) ? 1 : 2;
  if (doc.status === 'draft') return 3;
  return 4;
}

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;

  const [{ data: contracts }, { data: bills }, { data: totrinhs }] = await Promise.all([
    supabase.from('contracts').select('id, doc_number, value, status, current_step, project_id, projects(code)').eq('created_by', user.id),
    supabase.from('bills').select('id, doc_number, val_a, val_b, val_d, val_f, val_i, status, current_step, project_id, projects(code)').eq('created_by', user.id),
    supabase.from('to_trinh_chu_truong').select('id, doc_number, title, status, current_step, project_id, projects(code)').eq('created_by', user.id),
  ]);

  // Lấy thời điểm bắt đầu đúng bước hiện tại (để tính trễ hạn) — chỉ cần cho
  // hồ sơ đang pending, gộp 1 truy vấn cho cả 3 loại
  const pendingDocs = [
    ...(contracts || []).filter((c) => c.status === 'pending').map((c) => ({ type: 'contract', id: c.id, step: c.current_step })),
    ...(bills || []).filter((b) => b.status === 'pending').map((b) => ({ type: 'bill', id: b.id, step: b.current_step })),
    ...(totrinhs || []).filter((t) => t.status === 'pending').map((t) => ({ type: 'totrinh', id: t.id, step: t.current_step })),
  ];
  const stepCreatedMap = {};
  if (pendingDocs.length) {
    const { data: assigns } = await supabase
      .from('approval_assignments')
      .select('document_type, document_id, step_no, created_at')
      .in(
        'document_id',
        pendingDocs.map((d) => d.id),
      );
    (assigns || []).forEach((a) => {
      const key = `${a.document_type}:${a.document_id}:${a.step_no}`;
      if (!stepCreatedMap[key] || new Date(a.created_at) < new Date(stepCreatedMap[key])) stepCreatedMap[key] = a.created_at;
    });
  }

  const rows = [
    ...(contracts || []).map((c) => ({ type: 'contract', label: 'Hợp đồng', id: c.id, docNumber: c.doc_number, projectCode: c.projects?.code, value: c.value, status: c.status, current_step: c.current_step, stepCreatedAt: stepCreatedMap[`contract:${c.id}:${c.current_step}`] })),
    ...(bills || []).map((b) => ({ type: 'bill', label: 'Bill thanh toán', id: b.id, docNumber: b.doc_number, projectCode: b.projects?.code, value: Number(b.val_d) - 0.1 * Number(b.val_d) + Number(b.val_f) + Number(b.val_i), status: b.status, current_step: b.current_step, stepCreatedAt: stepCreatedMap[`bill:${b.id}:${b.current_step}`] })),
    ...(totrinhs || []).map((t) => ({ type: 'totrinh', label: 'Tờ trình chủ trương', id: t.id, docNumber: t.doc_number, projectCode: t.projects?.code, value: null, status: t.status, current_step: t.current_step, stepCreatedAt: stepCreatedMap[`totrinh:${t.id}:${t.current_step}`] })),
  ].sort((a, b) => priority(a) - priority(b));

  if (!rows.length) {
    container.innerHTML = `<div class="card empty-note"><div style="font-size:30px;margin-bottom:8px">📤</div><div style="font-weight:600;color:var(--gray7);margin-bottom:3px">Bạn chưa trình hồ sơ nào</div></div>`;
    return;
  }

  const rejectedCount = rows.filter((r) => r.status === 'rejected').length;
  const overdueCount = rows.filter(isOverdue).length;

  container.innerHTML = `
    ${rejectedCount ? `<div style="font-size:12.5px;background:#FEF2F2;color:var(--red);padding:9px 12px;border-radius:7px;margin-bottom:10px">🔴 <b>${rejectedCount} hồ sơ</b> đang bị từ chối — cần sửa và trình lại.</div>` : ''}
    ${overdueCount ? `<div style="font-size:12.5px;background:#FFF7ED;color:#B8790A;padding:9px 12px;border-radius:7px;margin-bottom:12px">⚠️ <b>${overdueCount} hồ sơ</b> đang chờ duyệt đã trễ hạn — nên bấm vào nhắc người duyệt.</div>` : ''}
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Số hồ sơ</th><th>Giá trị</th><th>Trạng thái</th></tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr class="click" data-type="${r.type}" data-id="${r.id}">
      <td><div class="mono">${r.docNumber}</div><div style="font-size:11px;color:var(--gray4);margin-top:2px">${r.projectCode || '—'} · ${r.label}${r.status === 'pending' ? ' · Bước ' + r.current_step : ''}</div></td>
      <td class="mono">${r.value != null ? fmt(r.value) : '—'}</td>
      <td>${statusBadge(r.status)}${isOverdue(r) ? '<div style="color:var(--red);font-weight:700;font-size:11px;margin-top:2px">⚠️ Trễ</div>' : ''}</td>
    </tr>`,
      )
      .join('')}
    </tbody></table></div>`;

  container.querySelectorAll('[data-type]').forEach((row) =>
    row.addEventListener('click', async () => {
      const type = row.dataset.type;
      const id = row.dataset.id;
      const mod = await import(`./${type === 'contract' ? 'hopdong' : type === 'bill' ? 'bill' : 'totrinh'}.js`);
      mod.openDetail(id, user, () => render(container, user));
    }),
  );
}
