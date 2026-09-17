// ============================================================
// stepPreview.js — "Dự kiến luồng phê duyệt" cho hồ sơ đang ở trạng thái NHÁP
//
// Hồ sơ nháp chưa được gán người duyệt (approval_assignments chỉ sinh ra lúc bấm
// Trình duyệt), nên trang chi tiết trước đây chỉ hiện đúng một dòng "Hồ sơ đang ở
// trạng thái nháp" — người lập không biết hồ sơ sẽ đi qua tay ai, phát hiện chọn
// nhầm mẫu thì đã trình mất rồi.
//
// Module này đọc mẫu hồ sơ + bảng phân quyền rồi TÍNH TRƯỚC ai sẽ được gán ở từng
// bước, mô phỏng đúng cách hàm _create_step_assignments bên database tìm người:
//   1. CHT/GDDA — và PTGD khi "theo dự án" — tra người phụ trách ĐÚNG DỰ ÁN;
//      không có ai thì bước đó bị BỎ QUA (đúng như hệ thống thật đang làm).
//   2. Vai trò khác: vẫn thử tra theo dự án trước (phòng khi có gán đích danh),
//      RIÊNG PTGD không-theo-dự-án thì bỏ qua bước này.
//   3. Không ra ai: mẫu Phòng ban + hồ sơ có phòng ban -> tra đúng phòng ban đó.
//   4. Cuối cùng: tra theo phòng ban ghi cứng ở bước, hoặc người ở mức toàn công ty.
//
// ⚠️ NẾU SAU NÀY SỬA _create_step_assignments thì phải sửa cả hàm resolveRow() dưới
// đây, nếu không số trên màn hình sẽ khác người thật sự được gán khi trình duyệt.
// ============================================================
import { supabase } from './config.js';

export async function flowPreviewHtml(projectId, templateId, originDepartment) {
  if (!templateId) {
    return `<div class="warn-box">⚠️ <div>Hồ sơ chưa chọn <b>Mẫu hồ sơ (luồng duyệt)</b> — chưa xác định được sẽ đi qua những ai. Bấm <b>Sửa</b> để chọn mẫu.</div></div>`;
  }

  const [{ data: tpl }, { data: steps }, { data: projAssigns }, { data: roleHolders }] = await Promise.all([
    supabase.from('document_templates').select('name, origin_scope').eq('id', templateId).single(),
    supabase.from('template_steps').select('step_no, role_type, department, resolve_via_project').eq('template_id', templateId).order('step_no'),
    supabase.from('project_role_assignments').select('role_type, users(full_name)').eq('project_id', projectId).is('effective_to', null),
    supabase.from('user_roles').select('role_type, department, users(full_name)'),
  ]);

  if (!steps || !steps.length) {
    return `<div class="warn-box">⚠️ <div>Mẫu <b>${tpl?.name || '—'}</b> chưa thiết lập bước duyệt nào — trình lên sẽ bị kẹt ngay. Báo Admin bổ sung trước khi trình.</div></div>`;
  }

  const scope = tpl?.origin_scope || 'site';
  const nameOf = (arr) => [...new Set((arr || []).map((x) => x.users?.full_name).filter(Boolean))];

  function resolveRow(row) {
    const projectBound =
      row.role_type === 'CHT' ||
      row.role_type === 'GDDA' ||
      (row.role_type === 'PTGD' && (row.resolve_via_project || (scope === 'site' && !row.department)));

    // (1)(2) tra theo dự án — bỏ qua đúng 1 ngoại lệ: PTGD không gắn dự án
    if (!(row.role_type === 'PTGD' && !projectBound)) {
      const found = nameOf((projAssigns || []).filter((a) => a.role_type === row.role_type));
      if (found.length) return { names: found, src: 'theo dự án' };
    }
    if (projectBound) return { names: [], src: 'theo dự án' };

    // (3) mẫu Phòng ban: ưu tiên đúng phòng ban của hồ sơ
    if (!row.department && scope === 'department' && originDepartment) {
      const found = nameOf((roleHolders || []).filter((r) => r.role_type === row.role_type && r.department === originDepartment));
      if (found.length) return { names: found, src: originDepartment };
    }

    // (4) phòng ban ghi cứng ở bước, hoặc người ở mức toàn công ty
    const found = nameOf(
      (roleHolders || []).filter((r) => r.role_type === row.role_type && (row.department ? r.department === row.department : r.department == null)),
    );
    return { names: found, src: row.department || 'toàn công ty' };
  }

  const stepNos = [...new Set(steps.map((s) => s.step_no))].sort((a, b) => a - b);
  let missingCount = 0;

  const body = stepNos
    .map((no) => {
      const rows = steps.filter((s) => s.step_no === no);
      const lines = rows
        .map((row) => {
          const r = resolveRow(row);
          let who;
          if (!r.names.length) {
            missingCount += 1;
            who = `<span style="color:var(--red);font-weight:600">⚠️ chưa gán ai — bước này sẽ bị bỏ qua</span>`;
          } else {
            who = `<b>${r.names.join(', ')}</b>${r.names.length > 1 ? ` <span style="color:var(--gray5);font-size:11px">— chỉ cần 1 người duyệt</span>` : ''}`;
          }
          return `<div style="padding:3px 0">
            <span class="code-chip" style="font-size:10.5px">${row.role_type}</span>
            <span style="color:var(--gray5);font-size:11px">· ${r.src}</span>
            <span style="margin:0 6px;color:var(--gray4)">→</span>${who}
          </div>`;
        })
        .join('');
      return `<div style="display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--gray1)">
        <div style="flex-shrink:0;width:64px;font-size:11px;font-weight:700;color:var(--gray6);padding-top:4px">BƯỚC ${no}</div>
        <div style="flex:1;font-size:12.5px">${lines}</div>
      </div>`;
    })
    .join('');

  return `<div class="card" style="padding:4px 14px 10px">
    <div style="font-size:11.5px;color:var(--gray5);padding:8px 0 2px">
      Mẫu đang chọn: <b style="color:var(--gray7)">${tpl?.name || '—'}</b> · ${scope === 'site' ? 'Công trường' : 'Phòng ban'}
    </div>
    ${body}
    <div style="font-size:11.5px;color:var(--gray5);margin-top:9px;line-height:1.6">
      Đây là <b>dự kiến</b> tính theo phân quyền hiện tại. Người duyệt thật được chốt vào đúng lúc bấm <b>Trình duyệt</b> — nếu phân quyền thay đổi trước đó thì danh sách này đổi theo.
      ${missingCount ? `<div style="color:var(--red);font-weight:600;margin-top:5px">⚠️ Có ${missingCount} vai trò chưa gán được ai. Hồ sơ vẫn trình được nhưng sẽ bỏ qua các chốt duyệt đó — nên báo Admin gán người trước khi trình.</div>` : ''}
    </div>
  </div>`;
}
