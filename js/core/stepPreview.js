// ============================================================
// stepPreview.js — TÍNH TRƯỚC "ai sẽ duyệt" ở từng bước của 1 hồ sơ
//
// Đây là NƠI DUY NHẤT phía giao diện tính người duyệt dự kiến. Dùng cho:
//   • flowPreviewHtml()  -> khung "Dự kiến luồng phê duyệt" của hồ sơ NHÁP,
//                           và bảng xem trước trong form Sửa bill
//   • resolveFlow()      -> dữ liệu thô, approvalUI.loadStepPreview() dùng để vẽ
//                           dòng "— dự kiến" trên rail của hồ sơ ĐANG DUYỆT
//
// Mô phỏng ĐÚNG TỪNG NHÁNH của hàm database _create_step_assignments (đã đối chiếu
// nguyên văn định nghĩa hàm ngày 22/09/2026):
//   is_project_bound = CHT | GDDA | (PTGD và (resolve_via_project
//                                            hoặc (mẫu 'site' và bước KHÔNG ghi phòng)))
//   1. Trừ trường hợp "PTGD không gắn dự án": tra project_role_assignments của dự án
//      (đang hiệu lực: effective_from <= hôm nay, effective_to rỗng hoặc >= hôm nay).
//      Ra người -> xong.
//   2. Gắn dự án mà không ra ai -> BỎ QUA bước đó.
//   3. Mẫu 'department' + bước không ghi phòng + hồ sơ có phòng ban -> tra đúng phòng đó.
//   4. Còn lại: bước ghi phòng -> tra đúng phòng ghi ở bước;
//               bước không ghi phòng -> chỉ người giữ vai trò ở mức "toàn công ty".
//
// ⚠️ LỊCH SỬ LỖI: khung "dự kiến" trên hồ sơ đang duyệt trước đây gọi hàm database
//    fn_preview_step_assignees — một bản sao CŨ, không biết quy tắc "bước ghi phòng
//    thì bỏ qua tra dự án". Hậu quả: bước PTGD ghi "Phòng Vật Tư Thiết Bị" lại hiện
//    "Bùi Trọng Trí" (PTGD của dự án), trong khi hệ thống gán thật là Đỗ Trường An.
//    Đã bỏ hàm đó, mọi nơi giờ dùng chung file này.
//
// ⚠️ NẾU SAU NÀY SỬA _create_step_assignments thì PHẢI sửa hàm resolveRow() dưới đây.
// ============================================================
import { supabase } from './config.js';

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Trả về { tpl, stepNos, rowsByStep: { [stepNo]: [{ role_type, department, names:[], src }] } }
// hoặc null nếu không có mẫu.
export async function resolveFlow(projectId, templateId, originDepartment) {
  if (!templateId) return null;
  const today = todayIso();

  const [{ data: tpl }, { data: steps }, { data: projAssigns }, { data: roleHolders }] = await Promise.all([
    supabase.from('document_templates').select('name, origin_scope').eq('id', templateId).single(),
    supabase.from('template_steps').select('step_no, role_type, department, resolve_via_project').eq('template_id', templateId).order('step_no'),
    projectId
      ? supabase
          .from('project_role_assignments')
          .select('role_type, effective_from, effective_to, users(full_name)')
          .eq('project_id', projectId)
          .lte('effective_from', today)
          .or(`effective_to.is.null,effective_to.gte.${today}`)
      : Promise.resolve({ data: [] }),
    supabase.from('user_roles').select('role_type, department, users(full_name)'),
  ]);

  const scope = tpl?.origin_scope || 'site';
  const nameOf = (arr) => [...new Set((arr || []).map((x) => x.users?.full_name).filter(Boolean))];

  function resolveRow(row) {
    const projectBound =
      row.role_type === 'CHT' ||
      row.role_type === 'GDDA' ||
      (row.role_type === 'PTGD' && (row.resolve_via_project || (scope === 'site' && !row.department)));

    // (1) tra theo dự án — trừ đúng 1 ngoại lệ: PTGD không gắn dự án
    if (!(row.role_type === 'PTGD' && !projectBound)) {
      const found = nameOf((projAssigns || []).filter((a) => a.role_type === row.role_type));
      if (found.length) return { names: found, src: 'theo dự án' };
    }
    // (2) gắn dự án mà không ra ai -> bước bị bỏ qua
    if (projectBound) return { names: [], src: 'theo dự án' };

    // (3) mẫu Phòng ban, bước không ghi phòng: ưu tiên đúng phòng ban của hồ sơ
    if (!row.department && scope === 'department' && originDepartment) {
      const found = nameOf((roleHolders || []).filter((r) => r.role_type === row.role_type && r.department === originDepartment));
      if (found.length) return { names: found, src: originDepartment };
    }

    // (4) phòng ghi cứng ở bước, hoặc người ở mức toàn công ty
    const found = nameOf(
      (roleHolders || []).filter((r) => r.role_type === row.role_type && (row.department ? r.department === row.department : r.department == null)),
    );
    return { names: found, src: row.department || 'toàn công ty' };
  }

  const rowsByStep = {};
  (steps || []).forEach((row) => {
    const r = resolveRow(row);
    (rowsByStep[row.step_no] ||= []).push({ role_type: row.role_type, department: row.department, names: r.names, src: r.src });
  });
  const stepNos = Object.keys(rowsByStep).map(Number).sort((a, b) => a - b);

  return { tpl, scope, stepNos, rowsByStep, hasSteps: !!(steps && steps.length) };
}

export async function flowPreviewHtml(projectId, templateId, originDepartment) {
  if (!templateId) {
    return `<div class="warn-box">⚠️ <div>Hồ sơ chưa chọn <b>Mẫu hồ sơ (luồng duyệt)</b> — chưa xác định được sẽ đi qua những ai. Bấm <b>Sửa</b> để chọn mẫu.</div></div>`;
  }

  const flow = await resolveFlow(projectId, templateId, originDepartment);
  if (!flow || !flow.hasSteps) {
    return `<div class="warn-box">⚠️ <div>Mẫu <b>${flow?.tpl?.name || '—'}</b> chưa thiết lập bước duyệt nào — trình lên sẽ bị kẹt ngay. Báo Admin bổ sung trước khi trình.</div></div>`;
  }

  let missingCount = 0;
  const body = flow.stepNos
    .map((no) => {
      const lines = flow.rowsByStep[no]
        .map((r) => {
          let who;
          if (!r.names.length) {
            missingCount += 1;
            who = `<span style="color:var(--red);font-weight:600">⚠️ chưa gán ai — bước này sẽ bị bỏ qua</span>`;
          } else {
            who = `<b>${r.names.join(', ')}</b>${r.names.length > 1 ? ` <span style="color:var(--gray5);font-size:11px">— chỉ cần 1 người duyệt</span>` : ''}`;
          }
          return `<div style="padding:3px 0">
            <span class="code-chip" style="font-size:10.5px">${r.role_type}</span>
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
      Mẫu đang chọn: <b style="color:var(--gray7)">${flow.tpl?.name || '—'}</b> · ${flow.scope === 'site' ? 'Công trường' : 'Phòng ban'}
    </div>
    ${body}
    <div style="font-size:11.5px;color:var(--gray5);margin-top:9px;line-height:1.6">
      Đây là <b>dự kiến</b> tính theo phân quyền hiện tại. Người duyệt của mỗi bước được chốt vào đúng lúc hồ sơ <b>đi tới bước đó</b> — nếu phân quyền thay đổi trước lúc ấy thì danh sách này đổi theo.
      ${missingCount ? `<div style="color:var(--red);font-weight:600;margin-top:5px">⚠️ Có ${missingCount} vai trò chưa gán được ai. Hồ sơ vẫn trình được nhưng sẽ bỏ qua các chốt duyệt đó — nên báo Admin gán người trước khi trình.</div>` : ''}
    </div>
  </div>`;
}
