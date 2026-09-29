// ============================================================
// users.js — Quản lý người dùng, vai trò, phân công theo dự án.
// Chỉ Admin (IT) và Trưởng phòng QLCP&HĐ thấy tab này.
// ============================================================
import { supabase } from '../core/config.js';
import { toast, loading, fmtDate, pushModalHistory, popModalHistory } from '../core/utils.js';

const ALL_ROLES = ['QS', 'CHT', 'GDDA', 'ChuyenVienPhongBan', 'TruongPhongChucNang', 'PhapChe_CV', 'PhapChe_TP', 'KeToan_Vien', 'KeToan_Truong', 'QLCPHD_CV', 'QLCPHD_TP', 'PTGD', 'TGD', 'Admin'];
// Bất kỳ vai trò nào cũng có thể được chỉ đích danh theo dự án (trừ Admin — thuần kỹ thuật, không tham gia duyệt)
// (PROJECT_ROLES cũ đã bỏ — nay dùng OTHER_PROJECT_ROLES bên dưới, gộp chung màn Dự án)
const DOC_TYPE_LABEL = { contract: 'Hợp đồng', bill: 'Bill thanh toán', totrinh: 'Tờ trình chủ trương' };

// ============================================================
// CHỌN NGƯỜI DUYỆT THEO PHÒNG BAN — dùng chung cho form Tạo mẫu và Sửa mẫu
//
// TRƯỚC ĐÂY chỉ 3 vai trò (Trưởng phòng / Chuyên viên / PTGD) mới có ô chọn phòng
// ban, và riêng PTGD còn bị ẨN ô đó khi Đơn vị trình = Công trường. Hậu quả: không
// có cách nào chỉ định "PTGD phụ trách khối văn phòng" cho một mẫu Công trường —
// hệ thống luôn bắt PTGD phụ trách DỰ ÁN, dù nghiệp vụ cần người khác.
//
// Thực tế hàm _create_step_assignments bên database ĐÃ hỗ trợ sẵn: dòng bước nào có
// ghi department thì tra thẳng user_roles theo đúng phòng đó, kể cả mẫu Công trường
// (riêng PTGD: hễ có ghi phòng ban là KHÔNG tra theo dự án nữa). Chỉ giao diện chặn.
// Nên giờ mở ô chọn phòng ban cho MỌI vai trò tra theo user_roles.
//
// CHT/GDDA không có ô này vì luôn phân theo dự án, không bao giờ tra phòng ban.
// ============================================================
const NO_DEPT_ROLES = ['CHT', 'GDDA', 'Admin'];
const roleNeedsDept = (r) => !NO_DEPT_ROLES.includes(r);

// Dựng ô tick + ô chọn phòng ban cho 1 vai trò ở 1 bước
function roleRowHtml(step, role, deptOptions, checked) {
  return `<label style="font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer;min-width:0">
    <span style="white-space:nowrap">${role}</span>
    <input type="checkbox" class="step-role" data-step="${step}" data-role="${role}" ${checked ? 'checked' : ''} style="order:-1">
    ${roleNeedsDept(role) ? `<select class="step-dept form-input" data-step="${step}" data-role="${role}" style="flex:1 1 0;min-width:0;max-width:150px;padding:3px 7px;font-size:11px">${deptOptions}</select>` : ''}
  </label>`;
}

// Khối "Dự kiến ai duyệt" đặt ngay dưới mỗi bước — mô phỏng đúng cách hàm
// _create_step_assignments tìm người, để thấy ngay hậu quả của từng lựa chọn thay vì
// phải lưu rồi tạo hồ sơ thật mới biết ai được gán.
function stepPreviewHtml(step) {
  return `<div class="step-preview" data-step="${step}" style="font-size:11.5px;line-height:1.75;color:var(--gray6);margin:-6px 0 14px;padding:8px 12px;background:var(--gray1);border-radius:7px"></div>`;
}

function whoWillApprove(role, dept, scope, roleRows) {
  if (role === 'CHT' || role === 'GDDA') return '<i style="color:var(--gray5)">người phụ trách đúng dự án của hồ sơ</i>';
  if (role === 'Admin') return '<i style="color:var(--gray5)">—</i>';
  // PTGD để trống phòng ban: mẫu Công trường -> bám dự án; mẫu Phòng ban -> bám phòng của người trình
  if (role === 'PTGD' && !dept) {
    return scope === 'site'
      ? '<i style="color:var(--gray5)">PTGD phụ trách đúng dự án của hồ sơ</i>'
      : '<i style="color:var(--gray5)">PTGD phụ trách phòng ban của người trình</i>';
  }
  const rows = (roleRows || []).filter((r) => r.role_type === role && (dept ? r.department === dept : r.department == null));
  if (!rows.length) {
    return `<span style="color:var(--red);font-weight:600">⚠️ chưa ai giữ vai trò này${dept ? ' ở ' + dept : ' ở mức toàn công ty'} — bước sẽ bị BỎ QUA, không ai duyệt</span>`;
  }
  const names = [...new Set(rows.map((r) => r.users?.full_name || '(không rõ tên)'))];
  return `<b style="color:var(--green)">${names.join(', ')}</b>${names.length > 1 ? ' <span style="color:var(--gray5)">— chỉ cần 1 người duyệt là xong bước</span>' : ''}`;
}

// Gắn vào modal (Tạo mẫu / Sửa mẫu): vẽ lại khối dự kiến mỗi khi tick hoặc đổi phòng ban
function wireStepPreview(modal, roleRows) {
  function draw() {
    const scope = modal.querySelector('#fScope').value;
    modal.querySelectorAll('.step-preview').forEach((box) => {
      const step = box.dataset.step;
      const picks = [...modal.querySelectorAll(`.step-role[data-step="${step}"]:checked`)];
      if (!picks.length) {
        box.innerHTML = '<span style="color:var(--gray4)">Chưa chọn vai trò nào ở bước này</span>';
        return;
      }
      box.innerHTML =
        `<div style="font-size:10.5px;text-transform:uppercase;color:var(--gray5);margin-bottom:3px">Dự kiến ai duyệt</div>` +
        picks
          .map((cb) => {
            const role = cb.dataset.role;
            const dept = modal.querySelector(`.step-dept[data-step="${step}"][data-role="${role}"]`)?.value || null;
            return `<div><b>${role}</b>${dept ? ` <span style="color:var(--gray5)">· ${dept}</span>` : ''} → ${whoWillApprove(role, dept, scope, roleRows)}</div>`;
          })
          .join('');
    });
  }
  modal.addEventListener('change', (e) => {
    if (e.target.classList?.contains('step-role') || e.target.classList?.contains('step-dept') || e.target.id === 'fScope') draw();
  });
  draw();
  return draw;
}

// ============================================================
// BƯỚC TRÌNH — AI ĐƯỢC TẠO HỒ SƠ THEO MẪU NÀY (bảng template_submitters)
//
// TRƯỚC ĐÂY quyền trình bị SUY RA từ "Đơn vị trình" (origin_scope) cộng một danh
// sách vai trò VIẾT CỨNG trong thân hàm can_submit_document:
//   Công trường -> ai được phân bổ vào dự án, HOẶC 6 vai trò văn phòng cố định
//   Phòng ban   -> ai giữ đúng vai trò ở Bước 1 của mẫu
// Hậu quả: mỗi tình huống nghiệp vụ mới là phải sửa code hàm. Chuyên viên phòng
// VTTB không trình được tờ trình thiết bị chính vì vậy — ChuyenVienPhongBan không
// nằm trong 6 vai trò cố định kia.
//
// GIỜ mẫu TỰ KHAI ai được trình. Mỗi dòng là một nhóm; khớp 1 dòng là trình được.
// Cờ "thuộc dự án" là chỗ tách bạch hai nghiệp vụ khác nhau trên CÙNG một mẫu:
//   QS công trường    -> BẬT : chỉ trình cho dự án mình được phân bổ
//   Chuyên viên phòng -> TẮT : trình cho mọi dự án (nhưng chỉ trên mẫu này)
//
// ⚠️ Ô phòng ban ở khối này có nghĩa KHÁC ô phòng ban ở các Bước duyệt:
//   Bước duyệt : để trống = tìm người KHÔNG thuộc phòng nào (mức toàn công ty)
//   Bước trình : để trống = phòng nào cũng được
// Nên nhãn hai ô cũng viết khác nhau — đừng đồng nhất chúng.
// ============================================================
const SUBMIT_ANY = '__ANY__';

// Tên tiếng Việt của từng vai trò — người đọc màn quản trị không phải dân IT,
// đừng bắt họ tự dịch mã QLCPHD_CV trong đầu.
const ROLE_LABEL = {
  QS: 'QS — Kỹ sư khối lượng (công trường)',
  CHT: 'Chỉ huy trưởng',
  GDDA: 'Giám đốc dự án',
  ChuyenVienPhongBan: 'Chuyên viên phòng ban',
  TruongPhongChucNang: 'Trưởng phòng chức năng',
  PhapChe_CV: 'Chuyên viên Pháp chế',
  PhapChe_TP: 'Trưởng phòng Pháp chế',
  KeToan_Vien: 'Kế toán viên',
  KeToan_Truong: 'Kế toán trưởng',
  QLCPHD_CV: 'Chuyên viên Quản lý chi phí & Hợp đồng',
  QLCPHD_TP: 'Trưởng phòng Quản lý chi phí & Hợp đồng',
  PTGD: 'Phó Tổng Giám đốc',
  TGD: 'Tổng Giám đốc',
  Admin: 'Quản trị hệ thống',
};
const roleText = (r) => ROLE_LABEL[r] || r;
// QS/CHT/GĐDA gắn với DỰ ÁN chứ không thuộc phòng ban nào — ghi thêm "phòng nào
// cũng được" cho mấy vai trò này chỉ làm rối, không mang thông tin gì.
const roleSitsInDept = (r) => !NO_DEPT_ROLES.includes(r) && r !== 'QS';

// Ai thực sự đang giữ vai trò đó — để nói thẳng TÊN NGƯỜI thay vì để người dùng
// đoán. Ở khối này, phòng ban để trống = PHÒNG NÀO CŨNG ĐƯỢC (khác Bước duyệt).
function submitRuleWho(rule, roleRows) {
  if (!rule.role_type) return 'mọi người có tên trong danh sách phân bổ của dự án';
  const rows = (roleRows || []).filter((r) => r.role_type === rule.role_type && (rule.department ? r.department === rule.department : true));
  if (!rows.length) {
    return `<span style="color:var(--red);font-weight:600">⚠️ hiện chưa ai giữ vai trò này${rule.department ? ' ở ' + rule.department : ''} — dòng này chưa có tác dụng</span>`;
  }
  const names = [...new Set(rows.map((r) => r.users?.full_name || '(không rõ tên)'))];
  return `<b style="color:var(--green)">${names.join(', ')}</b>`;
}

// Một dòng quyền trình đã khai, viết thành câu đọc được
function submitRuleHtml(rule, idx, roleRows) {
  const isAny = !rule.role_type;
  const who = isAny
    ? '<b>Bất kỳ ai được phân bổ vào dự án</b> <span style="color:var(--gray5)">(không cần giữ vai trò nào)</span>'
    : `<b>${roleText(rule.role_type)}</b>${rule.department
        ? ` <span style="color:var(--gray5)">· ${rule.department}</span>`
        : roleSitsInDept(rule.role_type) ? ' <span style="color:var(--gray5)">· phòng nào cũng được</span>' : ''}`;
  const needAssign = isAny || rule.requires_project_assignment;
  const scope = needAssign
    ? '<span style="background:#FEF3C7;color:#92400E;border-radius:4px;padding:1px 6px;font-size:11px;white-space:nowrap">chỉ dự án được phân bổ</span>'
    : '<span style="background:#DCFCE7;color:#166534;border-radius:4px;padding:1px 6px;font-size:11px;white-space:nowrap">mọi dự án</span>';
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--gray1)">
    <div style="font-size:13px;line-height:1.65">
      <div>${who} ${scope}</div>
      <div style="font-size:11.5px;color:var(--gray5);margin-top:2px">→ ${submitRuleWho(rule, roleRows)}</div>
    </div>
    <span data-rm-sub="${idx}" style="cursor:pointer;color:var(--red);font-size:12px;white-space:nowrap">Gỡ</span>
  </div>`;
}

// Khối BƯỚC TRÌNH: danh sách đã khai + form thêm dòng mới.
// CỐ TÌNH bỏ lưới 14 ô tick của bản trước — bắt người đọc dịch mã vai trò rồi tự
// suy ra luật từ 3 ô điều khiển cạnh nhau là quá nhiều việc cho một màn cấu hình.
function submitBlockHtml(departments) {
  const roleOpts =
    `<option value="${SUBMIT_ANY}">Bất kỳ ai được phân bổ vào dự án (không cần vai trò)</option>` +
    ALL_ROLES.filter((r) => r !== 'Admin').map((r) => `<option value="${r}">${roleText(r)}</option>`).join('');
  const deptOpts = `<option value="">Phòng nào cũng được</option>${(departments || []).map((d) => `<option value="${d.name}">${d.name}</option>`).join('')}`;
  return `
    <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Bước trình — ai được TẠO hồ sơ theo mẫu này</div>
    <div style="font-size:12px;color:var(--gray6);background:#ECFDF5;border-radius:7px;padding:10px 12px;margin-bottom:8px;line-height:1.7">
      Mỗi dòng bên dưới là <b>một nhóm người được phép trình</b>. Một người khớp <b>bất kỳ dòng nào</b> là trình được — các dòng cộng dồn với nhau, không phải điều kiện "và".
      <div style="margin-top:7px">Cột phạm vi có 2 lựa chọn:</div>
      <div style="margin-left:4px"><span style="background:#FEF3C7;color:#92400E;border-radius:4px;padding:1px 6px;font-size:11px">chỉ dự án được phân bổ</span> — người đó chỉ trình được cho những dự án mình có tên trong danh sách phụ trách. Dùng cho <b>QS công trường</b>.</div>
      <div style="margin-left:4px;margin-top:3px"><span style="background:#DCFCE7;color:#166534;border-radius:4px;padding:1px 6px;font-size:11px">mọi dự án</span> — trình được cho tất cả dự án, không cần phân bổ. Dùng cho <b>chuyên viên phòng ban</b>, vì phòng làm việc cho cả công ty.</div>
      <div style="margin-top:8px;padding-top:7px;border-top:1px dashed #A7F3D0"><b>Ví dụ mẫu "Bill Vật Tư Thiết Bị"</b> khai 2 dòng:
        QS · <i>chỉ dự án được phân bổ</i> → QS dự án nào up bill dự án đó;
        Chuyên viên phòng ban · Phòng Vật Tư Thiết Bị · <i>mọi dự án</i> → chuyên viên phòng up bill thiết bị cho mọi dự án.</div>
    </div>
    <div class="card" style="padding:12px 14px;margin-bottom:18px">
      <div id="subList" style="margin-bottom:12px"></div>
      <div style="border-top:1px solid var(--gray2);padding-top:11px">
        <div style="font-size:11px;text-transform:uppercase;color:var(--gray5);margin-bottom:7px">Thêm một nhóm được trình</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:9px;margin-bottom:9px">
          <div><label class="form-label">Nhóm người</label>
            <select id="subAddRole" class="form-input">${roleOpts}</select></div>
          <div><label class="form-label">Thuộc phòng ban</label>
            <select id="subAddDept" class="form-input">${deptOpts}</select>
            <div style="font-size:10.5px;color:var(--gray4);margin-top:3px">Chọn một phòng thì chỉ người của phòng đó được trình.</div></div>
        </div>
        <div style="margin-bottom:10px"><label class="form-label">Được trình cho dự án nào</label>
          <select id="subAddScope" class="form-input">
            <option value="all">Mọi dự án — không cần được phân bổ vào dự án (chuyên viên phòng ban)</option>
            <option value="assigned">Chỉ những dự án người đó được phân bổ vào (QS công trường)</option>
          </select></div>
        <button type="button" class="btn btn-sm btn-secondary" id="subAdd">+ Thêm nhóm được trình</button>
      </div>
    </div>`;
}

// Gắn khối BƯỚC TRÌNH vào modal. Trả về hàm đọc ra danh sách hiện tại để lưu.
function wireSubmitEditor(modal, initialRules, roleRows) {
  let rules = (initialRules || []).map((r) => ({
    role_type: r.role_type || null,
    department: r.role_type ? r.department || null : null,
    requires_project_assignment: r.role_type ? !!r.requires_project_assignment : true,
  }));

  const list = modal.querySelector('#subList');
  const selRole = modal.querySelector('#subAddRole');
  const selDept = modal.querySelector('#subAddDept');
  const selScope = modal.querySelector('#subAddScope');
  if (!list) return { get: () => rules, set: () => {} };

  function draw() {
    list.innerHTML = rules.length
      ? rules.map((r, i) => submitRuleHtml(r, i, roleRows)).join('')
      : '<div style="color:var(--red);font-weight:600;font-size:12.5px;padding:4px 0">⚠️ Chưa khai dòng nào — hiện KHÔNG AI tạo được hồ sơ theo mẫu này.</div>';
    list.querySelectorAll('[data-rm-sub]').forEach((el) =>
      el.addEventListener('click', () => {
        rules.splice(Number(el.dataset.rmSub), 1);
        draw();
      }),
    );
  }

  // Dòng "bất kỳ ai" và các vai trò không gắn phòng ban thì khóa 2 ô còn lại cho đỡ rối
  function syncAddForm() {
    const role = selRole.value;
    const isAny = role === SUBMIT_ANY;
    const noDept = isAny || NO_DEPT_ROLES.includes(role);
    selDept.disabled = noDept;
    if (noDept) selDept.value = '';
    selScope.disabled = isAny;
    if (isAny) selScope.value = 'assigned';
    selDept.style.background = selDept.disabled ? 'var(--gray1)' : '';
    selScope.style.background = selScope.disabled ? 'var(--gray1)' : '';
  }

  selRole.addEventListener('change', syncAddForm);
  modal.querySelector('#subAdd').addEventListener('click', () => {
    const role = selRole.value === SUBMIT_ANY ? null : selRole.value;
    const dept = role && !selDept.disabled ? selDept.value.trim() || null : null;
    const need = role ? selScope.value === 'assigned' : true;
    if (rules.some((r) => r.role_type === role && (r.department || null) === dept)) {
      return toast('Nhóm này đã có trong danh sách rồi', 'error');
    }
    rules.push({ role_type: role, department: dept, requires_project_assignment: need });
    draw();
  });

  syncAddForm();
  draw();
  return {
    get: () => rules,
    set: (rs) => {
      rules = (rs || []).map((r) => ({
        role_type: r.role_type || null,
        department: r.role_type ? r.department || null : null,
        requires_project_assignment: r.role_type ? !!r.requires_project_assignment : true,
      }));
      draw();
    },
  };
}

// ============================================================
// PHÒNG BAN ĐƯỢC XEM — bảng template_viewers
//
// TRƯỚC ĐÂY chỉ người ĐÍCH DANH có tên mới xem được hồ sơ: người tạo, hoặc người
// được gán duyệt. Đo ngày 29/09: chuyên viên phòng VTTB thấy đúng 5 bill trên
// tổng 159 — hồ sơ cùng luồng do người khác trình thì không thấy, nghỉ phép một
// hôm là công việc đứng.
//
// GIỜ mẫu khai luôn PHÒNG NÀO ĐƯỢC XEM. Ai thuộc phòng đó — trưởng phòng hay
// chuyên viên — đều xem được mọi hồ sơ theo mẫu đó, ở mọi dự án, bất kể ai trình.
// CHỈ quyền xem. Ai được duyệt vẫn do các Bước quyết định, không đổi.
// ============================================================
function viewerBlockHtml(departments) {
  const list = (departments || []);
  return `
    <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Phòng ban được XEM hồ sơ theo mẫu này</div>
    <div style="font-size:12px;color:var(--gray6);background:#EFF6FF;border-radius:7px;padding:10px 12px;margin-bottom:8px;line-height:1.7">
      Tick phòng nào thì <b>toàn bộ người của phòng đó</b> (trưởng phòng và mọi chuyên viên) xem được <b>mọi hồ sơ theo mẫu này, ở mọi dự án</b> — kể cả hồ sơ do QS công trường trình, không cần đích danh có tên trong luồng.
      <div style="margin-top:6px">Để phòng làm việc theo phòng: người nghỉ phép thì đồng nghiệp vẫn mở được hồ sơ, không phải chờ.</div>
      <div style="margin-top:6px;color:var(--gray5)">Đây <b>chỉ là quyền xem</b>. Ai được phê duyệt vẫn do các Bước bên dưới quyết định — tick ở đây không cho ai thêm quyền duyệt.</div>
    </div>
    <div class="card" style="padding:12px 14px;margin-bottom:18px">
      ${list.length
        ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:7px 12px">
             ${list.map((d) => `<label style="font-size:12.5px;display:flex;align-items:center;gap:7px;cursor:pointer">
               <input type="checkbox" class="tv-dept" data-dept="${d.name}">${d.name}
             </label>`).join('')}
           </div>
           <div id="tvPreview" style="font-size:11.5px;line-height:1.7;color:var(--gray6);margin-top:11px;padding:8px 12px;background:var(--gray1);border-radius:7px"></div>`
        : `<div style="color:var(--gray4);font-size:12px">Chưa có phòng ban nào trong hệ thống.</div>`}
    </div>`;
}

function wireViewerBlock(modal, current, roleRows) {
  const box = modal.querySelector('#tvPreview');
  function apply(depts) {
    modal.querySelectorAll('.tv-dept').forEach((cb) => (cb.checked = (depts || []).includes(cb.dataset.dept)));
    draw();
  }
  function draw() {
    if (!box) return;
    const picked = [...modal.querySelectorAll('.tv-dept:checked')].map((cb) => cb.dataset.dept);
    if (!picked.length) {
      box.innerHTML = '<span style="color:var(--gray5)">Chưa tick phòng nào — chỉ người tạo hồ sơ và người có tên trong luồng duyệt mới xem được.</span>';
      return;
    }
    box.innerHTML =
      '<div style="font-size:10.5px;text-transform:uppercase;color:var(--gray5);margin-bottom:3px">Những ai sẽ xem được</div>' +
      picked.map((d) => {
        const names = [...new Set((roleRows || []).filter((r) => r.department === d).map((r) => r.users?.full_name).filter(Boolean))];
        return `<div><b>${d}</b> → ${names.length
          ? `<span style="color:var(--green);font-weight:600">${names.join(', ')}</span>`
          : '<span style="color:var(--red);font-weight:600">⚠️ phòng này chưa có ai — dòng này chưa có tác dụng</span>'}</div>`;
      }).join('');
  }
  modal.addEventListener('change', (e) => {
    if (e.target.classList?.contains('tv-dept')) draw();
  });
  apply((current || []).map((r) => r.department));
  return { get: () => [...modal.querySelectorAll('.tv-dept:checked')].map((cb) => cb.dataset.dept), set: apply };
}

// Danh sách vai trò gắn với từng người — nguồn để tính khối "Dự kiến ai duyệt"
async function fetchRoleHolders() {
  const { data } = await supabase.from('user_roles').select('role_type, department, users(full_name)');
  return data || [];
}

const SCOPE_HINT = 'Dùng để TÌM PTGD phụ trách: Công trường = PTGD của dự án; Phòng ban = PTGD của phòng người trình. KHÔNG còn quyết định ai được trình — việc đó nay do khối BƯỚC TRÌNH bên dưới quyết định.';

export async function render(container, user) {
  container.innerHTML = `<div class="empty-note">Đang tải…</div>`;
  const isAdmin = (user.roles || []).includes('Admin'); // chỉ Admin mới thêm/sửa được tài khoản + vai trò hệ thống

  // Gọi TẤT CẢ cùng lúc (song song) thay vì tuần tự — trước đây mỗi dòng đợi
  // xong mới gọi dòng tiếp theo, cộng dồn lại mất vài giây; giờ chỉ mất đúng
  // bằng thời gian của lần gọi chậm nhất.
  const [
    { data: templates },
    { data: allSteps },
    { data: allSubmitters, error: subErr },
    { data: projects, error: projErr },
    { data: departments, error: deptErr },
    { data: budgetCats, error: bcErr },
    { data: users, error },
    { data: roles },
  ] = await Promise.all([
    supabase.from('document_templates').select('id, name, doc_type, origin_scope, is_active'),
    supabase.from('template_steps').select('template_id, step_no'),
    supabase.from('template_submitters').select('template_id'),
    supabase.from('projects').select('id, code, name, investor, location, project_type, unit_count, status').order('code'),
    supabase.from('departments').select('name').order('name'),
    supabase.from('budget_categories').select('code, name, group_code').order('code'),
    supabase.from('users').select('id, email, full_name, is_active').order('full_name'),
    supabase.from('user_roles').select('user_id, role_type'),
  ]);
  if (subErr) console.error('Lỗi tải BƯỚC TRÌNH:', subErr);

  const stepCountMap = {};
  (allSteps || []).forEach((s) => (stepCountMap[s.template_id] = (stepCountMap[s.template_id] || 0) + 1));
  // Mẫu nào chưa khai BƯỚC TRÌNH thì vẫn đang chạy bằng luật cũ (lưới an toàn bên
  // database). Đánh dấu ra để biết còn sót mẫu nào chưa chuyển đổi.
  const hasSubmitters = new Set((allSubmitters || []).map((s) => s.template_id));

  if (error) {
    container.innerHTML = `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${error.message}</div>`;
    return;
  }
  const roleMap = {};
  (roles || []).forEach((r) => (roleMap[r.user_id] = [...(roleMap[r.user_id] || []), r.role_type]));

  const statusVN = { active: 'Đang thi công', completed: 'Hoàn thành', paused: 'Tạm dừng' };

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Dự án</div>
      <button class="btn btn-primary btn-sm" id="btnNewProject">+ Tạo dự án mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:22px">
      ${projErr ? `<div class="empty-note">⚠️ Không có quyền xem, hoặc lỗi: ${projErr.message}</div>` : `
      <table><thead><tr><th>Mã</th><th>Tên dự án</th><th>Chủ đầu tư</th><th>Địa điểm</th><th>Loại hình</th><th>Số căn</th><th>Trạng thái</th></tr></thead><tbody>
      ${projects && projects.length ? projects.map((p) => `<tr class="click proj-row" data-id="${p.id}" data-name="${p.name}"><td class="mono">${p.code}</td><td>${p.name}</td><td>${p.investor || '—'}</td><td>${p.location || '—'}</td><td>${p.project_type || '—'}</td><td>${p.unit_count || '—'}</td><td><span class="badge idle">${statusVN[p.status] || p.status}</span></td></tr>`).join('') :
      `<tr><td colspan="7" style="text-align:center;color:var(--gray4);padding:20px">Chưa có dự án nào</td></tr>`}
      </tbody></table>`}
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Phòng ban</div>
      <button class="btn btn-primary btn-sm" id="btnNewDept">+ Tạo phòng ban mới</button>
    </div>
    <div class="card" style="margin-bottom:22px">
      ${deptErr ? `<div class="empty-note">⚠️ Lỗi: ${deptErr.message}</div>` :
      departments && departments.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${departments.map((d) => `<span class="code-chip dept-chip" data-name="${d.name}" style="cursor:pointer">${d.name}</span>`).join('')}</div>` :
      `<div class="empty-note">Chưa có phòng ban nào — tạo trước khi gán Trưởng phòng/Chuyên viên/PTGD theo phòng ban.</div>`}
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Mã ngân sách (danh mục mẫu — do phòng KSCP quản lý)</div>
      <button class="btn btn-primary btn-sm" id="btnNewBudgetCat">+ Tạo mã ngân sách mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:22px">
      ${bcErr ? `<div class="empty-note">⚠️ Lỗi: ${bcErr.message}</div>` : `
      <table><thead><tr><th>Mã</th><th>Tên</th><th>Nhóm</th></tr></thead><tbody>
      ${budgetCats && budgetCats.length ? budgetCats.map((c) => `<tr class="click bc-row" data-code="${c.code}"><td class="mono">${c.code}</td><td>${c.name}</td><td>${c.group_code || '—'}</td></tr>`).join('') :
      `<tr><td colspan="3" style="text-align:center;color:var(--gray4);padding:20px">Chưa có mã ngân sách nào</td></tr>`}
      </tbody></table>`}
      <div style="font-size:11px;color:var(--gray4);padding:8px 14px">Đây là danh mục MẪU dùng chung — khi tạo phiên bản ngân sách cho từng dự án, chỉ cần chọn đúng những mã liên quan tới dự án đó, không bắt buộc dùng hết.</div>
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Mẫu hồ sơ (luồng duyệt)</div>
      <button class="btn btn-primary btn-sm" id="btnNewTemplate">+ Tạo mẫu mới</button>
    </div>
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:22px">
      <table><thead><tr><th>Tên mẫu</th><th>Áp dụng cho loại hồ sơ</th><th>Ai được trình</th><th>Nguồn (tìm PTGD)</th><th>Số bước</th></tr></thead><tbody>
      ${templates && templates.length ? templates.map((t) => `<tr class="click" data-template-id="${t.id}"><td>${t.name}</td><td><span class="badge info">${DOC_TYPE_LABEL[t.doc_type] || t.doc_type}</span></td>
      <td>${hasSubmitters.has(t.id) ? '<span class="badge done">Đã khai</span>' : '<span class="badge" style="background:#FEF3C7;color:#92400E">Chưa khai — chạy luật cũ</span>'}</td>
      <td>${t.origin_scope === 'site' ? 'Công trường' : 'Phòng ban'}</td><td>${stepCountMap[t.id] || 0} vai trò / ${new Set((allSteps || []).filter((s) => s.template_id === t.id).map((s) => s.step_no)).size} bước</td></tr>`).join('') :
      `<tr><td colspan="5" style="text-align:center;color:var(--gray4);padding:20px">Chưa có mẫu hồ sơ nào</td></tr>`}
      </tbody></table>
      <div style="font-size:11px;color:var(--gray4);padding:8px 14px">Cột "Ai được trình" = khối BƯỚC TRÌNH trong mẫu. Mẫu còn "Chưa khai" vẫn chạy bằng luật cũ suy từ cột Nguồn — mở mẫu ra, tick người được trình rồi Lưu là xong.</div>
    </div>

    <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
      <div class="card-title" style="margin:0">Người dùng</div>
      ${isAdmin ? `<button class="btn btn-primary btn-sm" id="btnNew">+ Thêm người dùng</button>` : ''}
    </div>
    <div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Họ tên</th><th>Email</th><th>Vai trò</th><th>Trạng thái</th></tr></thead><tbody>
    ${users && users.length ? users.map((u) => `<tr ${isAdmin ? 'class="click"' : ''} data-id="${u.id}"><td>${u.full_name}</td><td class="mono">${u.email}</td>
    <td>${(roleMap[u.id] || []).map((r) => `<span class="code-chip" style="margin:1px 3px 1px 0">${r}</span>`).join('') || '<span style="color:var(--amber);font-size:12px">Chưa gán</span>'}</td>
    <td>${u.is_active ? '<span class="badge done">Đang hoạt động</span>' : '<span class="badge danger">Đã khóa</span>'}</td></tr>`).join('') :
    `<tr><td colspan="4" style="text-align:center;color:var(--gray4);padding:20px">Chưa có người dùng nào</td></tr>`}
    </tbody></table></div>
    ${!isAdmin ? `<div style="font-size:11.5px;color:var(--gray4);margin-top:6px">Chỉ Admin mới thêm/sửa được tài khoản và vai trò hệ thống — phần này chỉ xem được.</div>` : ''}`;

  container.querySelector('#btnNewProject').addEventListener('click', () => openCreateProjectModal(() => render(container, user)));
  container.querySelectorAll('.proj-row').forEach((row) => row.addEventListener('click', () => openProjectAssignModal(row.dataset.id, row.dataset.name, user, () => render(container, user))));
  container.querySelector('#btnNewDept').addEventListener('click', () => openCreateDeptModal(() => render(container, user)));
  container.querySelectorAll('.dept-chip').forEach((chip) => chip.addEventListener('click', () => openEditDeptModal(chip.dataset.name, () => render(container, user))));
  container.querySelector('#btnNewBudgetCat').addEventListener('click', () => openCreateBudgetCatModal(() => render(container, user)));
  container.querySelectorAll('.bc-row').forEach((row) => row.addEventListener('click', () => openEditBudgetCatModal(row.dataset.code, () => render(container, user))));
  container.querySelector('#btnNewTemplate').addEventListener('click', () => openCreateTemplateModal(() => render(container, user)));
  container.querySelectorAll('[data-template-id]').forEach((row) => row.addEventListener('click', () => openEditTemplateModal(row.dataset.templateId, () => render(container, user))));
  if (isAdmin) {
    container.querySelector('#btnNew').addEventListener('click', () => openCreateUserModal(user, () => render(container, user)));
    container.querySelectorAll('[data-id]').forEach((r) => r.addEventListener('click', () => openUserDetail(r.dataset.id, user, () => render(container, user))));
  }
}

async function openCreateTemplateModal(onClose) {
  const modal = ensureModal();
  const { data: existingTemplates } = await supabase.from('document_templates').select('id, name');
  const { data: departments } = await supabase.from('departments').select('name').order('name');
  const roleHolders = await fetchRoleHolders();
  const deptOptions = `<option value="">— Mọi phòng ban —</option>${(departments || []).map((d) => `<option value="${d.name}">${d.name}</option>`).join('')}`;
  modal.innerHTML = `<div class="panel-box" style="max-width:940px">
    <div class="panel-header"><div>Tạo mẫu hồ sơ mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Mỗi bước phải chọn ít nhất 1 vai trò — bỏ trống 1 bước sẽ khiến hồ sơ bị kẹt mãi ở bước đó, không ai duyệt được.</div>
      ${!departments || !departments.length ? `<div class="warn-box">⚠️ <div>Chưa có phòng ban nào trong hệ thống — vào khối "Phòng ban" ở trên tạo trước, nếu không sẽ không chọn được đúng Trưởng phòng/Chuyên viên/PTGD theo phòng ban.</div></div>` : ''}
      ${existingTemplates && existingTemplates.length ? `<div style="margin-bottom:16px"><label class="form-label">Nhân bản từ mẫu có sẵn (không bắt buộc — đỡ phải tick lại từ đầu)</label>
        <select id="fCopyFrom" class="form-input"><option value="">— Tạo từ đầu —</option>${existingTemplates.map((t) => `<option value="${t.id}">${t.name}</option>`).join('')}</select></div>` : ''}
      <div style="margin-bottom:13px"><label class="form-label">Tên mẫu *</label><input type="text" id="fName" class="form-input" placeholder="VD: Hợp đồng văn phòng - Phòng Thiết bị"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Áp dụng cho loại hồ sơ *</label>
          <select id="fDocType" class="form-input"><option value="contract">Hợp đồng</option><option value="bill">Bill thanh toán</option><option value="totrinh">Tờ trình chủ trương</option></select></div>
        <div><label class="form-label">Nguồn phát sinh hồ sơ *</label>
          <select id="fScope" class="form-input"><option value="site">Công trường</option><option value="department">Phòng ban</option></select>
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">${SCOPE_HINT}</div></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Mô tả</label><input type="text" id="fDesc" class="form-input"></div>

      ${submitBlockHtml(departments)}

      ${viewerBlockHtml(departments)}

      <div style="font-size:11.5px;color:var(--gray6);background:#FFF7ED;border-radius:7px;padding:9px 12px;margin-bottom:12px">
        💡 Ô phòng ban cạnh mỗi vai trò = <b>chỉ định đích danh người duyệt</b>. Để trống thì hệ thống tự tìm người ở mức toàn công ty.
        Chọn một phòng ban thì chỉ người giữ vai trò đó <b>ở đúng phòng ban ấy</b> mới được gán.
        Khối xám dưới mỗi bước cho biết ngay <b>ai sẽ duyệt</b>.
      </div>
      ${[1, 2, 3, 4].map((step) => `
        <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Bước ${step}</div>
        <div class="card" style="padding:10px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:6px 10px">
          ${ALL_ROLES.map((r) => roleRowHtml(step, r, deptOptions, false)).join('')}
        </div>
        ${stepPreviewHtml(step)}`).join('')}
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu mẫu hồ sơ</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  // Ô phòng ban giờ hiện cho MỌI vai trò và ở CẢ hai kiểu Nguồn phát sinh — xem ghi chú
  // ở đầu file. Thay cho việc ẩn/hiện, dưới mỗi bước có khối "Dự kiến ai duyệt" cho
  // biết ngay lựa chọn hiện tại sẽ ra đúng người nào.
  const redrawPreview = wireStepPreview(modal, roleHolders);
  const submitEditor = wireSubmitEditor(modal, null, roleHolders);
  const viewerBlock = wireViewerBlock(modal, null, roleHolders);

  // Nhân bản: tick sẵn đúng các ô của mẫu được chọn, kể cả phòng ban đã ghi VÀ cả khối
  // BƯỚC TRÌNH — không chép khối này thì mẫu mới sẽ không ai trình được.
  modal.querySelector('#fCopyFrom')?.addEventListener('change', async (e) => {
    modal.querySelectorAll('.step-role').forEach((cb) => (cb.checked = false));
    modal.querySelectorAll('.step-dept').forEach((inp) => (inp.value = ''));
    submitEditor.set([]);
    viewerBlock.set([]);
    if (!e.target.value) {
      redrawPreview();
      return;
    }
    const [{ data: steps }, { data: subs }, { data: views }] = await Promise.all([
      supabase.from('template_steps').select('step_no, role_type, department').eq('template_id', e.target.value),
      supabase.from('template_submitters').select('role_type, department, requires_project_assignment').eq('template_id', e.target.value),
      supabase.from('template_viewers').select('department').eq('template_id', e.target.value),
    ]);
    (steps || []).forEach((s) => {
      const cb = modal.querySelector(`.step-role[data-step="${s.step_no}"][data-role="${s.role_type}"]`);
      if (cb) cb.checked = true;
      const dept = modal.querySelector(`.step-dept[data-step="${s.step_no}"][data-role="${s.role_type}"]`);
      if (dept && s.department) dept.value = s.department;
    });
    submitEditor.set(subs || []);
    viewerBlock.set(views || []);
    redrawPreview();
    toast('Đã sao chép cấu hình — chỉnh sửa rồi lưu như mẫu mới', 'info');
  });

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fName').value.trim();
    const doc_type = modal.querySelector('#fDocType').value;
    const origin_scope = modal.querySelector('#fScope').value;
    const description = modal.querySelector('#fDesc').value.trim();
    if (!name) return toast('Điền tên mẫu', 'error');

    const submitters = submitEditor.get();
    if (!submitters.length) return toast('Khối BƯỚC TRÌNH đang trống — phải chọn ít nhất 1 nhóm được trình, nếu không sẽ không ai tạo được hồ sơ theo mẫu này', 'error');

    const checked = [...modal.querySelectorAll('.step-role:checked')].map((el) => {
      const deptInput = modal.querySelector(`.step-dept[data-step="${el.dataset.step}"][data-role="${el.dataset.role}"]`);
      return { step_no: Number(el.dataset.step), role_type: el.dataset.role, department: deptInput?.value.trim() || null };
    });
    const usedSteps = new Set(checked.map((c) => c.step_no));
    if (usedSteps.size < 1) return toast('Phải chọn ít nhất 1 vai trò ở ít nhất 1 bước', 'error');
    for (let s = 1; s <= Math.max(...usedSteps); s++) {
      if (!usedSteps.has(s)) return toast(`Bước ${s} đang trống nhưng bước ${s + 1} trở đi có chọn vai trò — phải điền đủ liên tiếp từ bước 1, không được bỏ trống ở giữa`, 'error');
    }

    loading(true);
    const { data: tpl, error } = await supabase.from('document_templates').insert({ name, doc_type, origin_scope, description }).select('id').single();
    if (error) return toast('Lỗi tạo mẫu: ' + error.message, 'error');

    const { error: stepErr } = await supabase.from('template_steps').insert(checked.map((c) => ({ template_id: tpl.id, step_no: c.step_no, role_type: c.role_type, department: c.department })));
    if (stepErr) return toast('Đã tạo mẫu nhưng lỗi lưu các bước: ' + stepErr.message, 'error');

    const { error: subSaveErr } = await supabase.from('template_submitters').insert(submitters.map((s) => ({ template_id: tpl.id, ...s })));
    if (subSaveErr) return toast('Đã tạo mẫu nhưng lỗi lưu BƯỚC TRÌNH: ' + subSaveErr.message, 'error');

    const viewerDepts = viewerBlock.get();
    if (viewerDepts.length) {
      const { error: tvErr } = await supabase.from('template_viewers').insert(viewerDepts.map((d) => ({ template_id: tpl.id, department: d })));
      if (tvErr) return toast('Đã tạo mẫu nhưng lỗi lưu Phòng ban được xem: ' + tvErr.message, 'error');
    }

    toast('Đã tạo mẫu hồ sơ mới', 'success');
    closeModal(modal, onClose);
  });
}

async function openEditTemplateModal(templateId, onClose) {
  const modal = ensureModal();
  const { data: tpl } = await supabase.from('document_templates').select('*').eq('id', templateId).single();
  if (!tpl) return toast('Không tải được mẫu hồ sơ', 'error');
  const { data: currentSteps } = await supabase.from('template_steps').select('step_no, role_type, department').eq('template_id', templateId);
  const { data: currentSubs, error: subLoadErr } = await supabase.from('template_submitters').select('role_type, department, requires_project_assignment').eq('template_id', templateId);
  if (subLoadErr) console.error('Lỗi tải BƯỚC TRÌNH:', subLoadErr);
  const { data: currentViewers, error: tvLoadErr } = await supabase.from('template_viewers').select('department').eq('template_id', templateId);
  if (tvLoadErr) console.error('Lỗi tải Phòng ban được xem:', tvLoadErr);
  const { data: departments } = await supabase.from('departments').select('name').order('name');
  const roleHolders = await fetchRoleHolders();
  const deptOptions = `<option value="">— Mọi phòng ban —</option>${(departments || []).map((d) => `<option value="${d.name}">${d.name}</option>`).join('')}`;
  modal.innerHTML = `<div class="panel-box" style="max-width:940px">
    <div class="panel-header"><div>Sửa mẫu hồ sơ — ${tpl.name}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Mỗi bước phải chọn ít nhất 1 vai trò — bỏ trống 1 bước sẽ khiến hồ sơ bị kẹt mãi ở bước đó, không ai duyệt được. Đổi ở đây chỉ ảnh hưởng hồ sơ CHƯA tới bước bị đổi — hồ sơ đã duyệt qua bước đó giữ nguyên lịch sử.</div>
      ${!currentSubs || !currentSubs.length ? `<div style="font-size:12px;background:#FEF3C7;color:#92400E;padding:9px 12px;border-radius:7px;margin-bottom:14px">⚠️ Mẫu này <b>chưa khai BƯỚC TRÌNH</b> — đang chạy bằng luật cũ suy từ Nguồn phát sinh. Tick người được trình ở khối màu xanh bên dưới rồi Lưu để chuyển sang luật mới.</div>` : ''}
      <div style="margin-bottom:13px"><label class="form-label">Tên mẫu *</label><input type="text" id="fName" class="form-input" value="${tpl.name}"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Áp dụng cho loại hồ sơ *</label>
          <select id="fDocType" class="form-input">
            <option value="contract" ${tpl.doc_type === 'contract' ? 'selected' : ''}>Hợp đồng</option>
            <option value="bill" ${tpl.doc_type === 'bill' ? 'selected' : ''}>Bill thanh toán</option>
            <option value="totrinh" ${tpl.doc_type === 'totrinh' ? 'selected' : ''}>Tờ trình chủ trương</option>
          </select></div>
        <div><label class="form-label">Nguồn phát sinh hồ sơ *</label>
          <select id="fScope" class="form-input">
            <option value="site" ${tpl.origin_scope === 'site' ? 'selected' : ''}>Công trường</option>
            <option value="department" ${tpl.origin_scope === 'department' ? 'selected' : ''}>Phòng ban</option>
          </select>
          <div style="font-size:11px;color:var(--gray4);margin-top:4px">${SCOPE_HINT}</div></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Mô tả</label><input type="text" id="fDesc" class="form-input" value="${tpl.description || ''}"></div>
      <div style="margin-bottom:13px"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="fActive" ${tpl.is_active !== false ? 'checked' : ''}> Đang hoạt động (bỏ tick để ngừng dùng mẫu này — hồ sơ đang chọn mẫu này không bị ảnh hưởng, chỉ ẩn khỏi danh sách chọn khi tạo hồ sơ mới)</label></div>

      ${submitBlockHtml(departments)}

      ${viewerBlockHtml(departments)}

      <div style="font-size:11.5px;color:var(--gray6);background:#FFF7ED;border-radius:7px;padding:9px 12px;margin-bottom:12px">
        💡 Ô phòng ban cạnh mỗi vai trò = <b>chỉ định đích danh người duyệt</b>. Để trống thì hệ thống tự tìm người ở mức toàn công ty.
        Chọn một phòng ban thì chỉ người giữ vai trò đó <b>ở đúng phòng ban ấy</b> mới được gán.
        Khối xám dưới mỗi bước cho biết ngay <b>ai sẽ duyệt</b>.
      </div>
      ${[1, 2, 3, 4].map((step) => `
        <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Bước ${step}</div>
        <div class="card" style="padding:10px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:6px 10px">
          ${ALL_ROLES.map((r) => roleRowHtml(step, r, deptOptions, !!(currentSteps || []).find((s) => s.step_no === step && s.role_type === r))).join('')}
        </div>
        ${stepPreviewHtml(step)}`).join('')}
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  // Điền sẵn đúng phòng ban đã ghi cho từng dòng (phải làm sau khi HTML đã dựng xong)
  (currentSteps || []).forEach((s) => {
    if (!s.department) return;
    const dept = modal.querySelector(`.step-dept[data-step="${s.step_no}"][data-role="${s.role_type}"]`);
    if (dept) dept.value = s.department;
  });
  // Ô phòng ban hiện cho MỌI vai trò, ở CẢ hai kiểu Nguồn phát sinh (xem ghi chú đầu file).
  // Khối "Dự kiến ai duyệt" dưới mỗi bước cập nhật ngay theo từng lựa chọn.
  wireStepPreview(modal, roleHolders);
  const submitEditor = wireSubmitEditor(modal, currentSubs, roleHolders);
  const viewerBlock = wireViewerBlock(modal, currentViewers, roleHolders);

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fName').value.trim();
    const doc_type = modal.querySelector('#fDocType').value;
    const origin_scope = modal.querySelector('#fScope').value;
    const description = modal.querySelector('#fDesc').value.trim();
    const is_active = modal.querySelector('#fActive').checked;
    if (!name) return toast('Điền tên mẫu', 'error');

    const submitters = submitEditor.get();
    if (!submitters.length) return toast('Khối BƯỚC TRÌNH đang trống — phải chọn ít nhất 1 nhóm được trình, nếu không sẽ không ai tạo được hồ sơ theo mẫu này', 'error');

    const checked = [...modal.querySelectorAll('.step-role:checked')].map((el) => {
      const deptInput = modal.querySelector(`.step-dept[data-step="${el.dataset.step}"][data-role="${el.dataset.role}"]`);
      return { step_no: Number(el.dataset.step), role_type: el.dataset.role, department: deptInput?.value.trim() || null };
    });
    const usedSteps = new Set(checked.map((c) => c.step_no));
    if (usedSteps.size < 1) return toast('Phải chọn ít nhất 1 vai trò ở ít nhất 1 bước', 'error');
    for (let s = 1; s <= Math.max(...usedSteps); s++) {
      if (!usedSteps.has(s)) return toast(`Bước ${s} đang trống nhưng bước ${s + 1} trở đi có chọn vai trò — phải điền đủ liên tiếp từ bước 1, không được bỏ trống ở giữa`, 'error');
    }

    loading(true);
    const { error } = await supabase.from('document_templates').update({ name, doc_type, origin_scope, description, is_active }).eq('id', templateId);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');

    // Xóa hết bước cũ, ghi lại đúng theo trạng thái tick hiện tại — đơn giản, chắc chắn
    // đồng bộ đúng. Hồ sơ ĐÃ tạo trước đó không bị ảnh hưởng (approval_assignments là
    // dữ liệu riêng, đã "chụp ảnh" sẵn lúc tạo, không đọc lại template_steps sau này).
    await supabase.from('template_steps').delete().eq('template_id', templateId);
    const { error: stepErr } = await supabase.from('template_steps').insert(checked.map((c) => ({ template_id: templateId, step_no: c.step_no, role_type: c.role_type, department: c.department })));
    if (stepErr) return toast('Đã lưu mẫu nhưng lỗi lưu các bước: ' + stepErr.message, 'error');

    // Khối BƯỚC TRÌNH làm y hệt: xóa sạch rồi ghi lại. Quyền trình chỉ xét lúc TẠO hồ
    // sơ mới, nên hồ sơ cũ không bị ảnh hưởng gì.
    await supabase.from('template_submitters').delete().eq('template_id', templateId);
    const { error: subSaveErr } = await supabase.from('template_submitters').insert(submitters.map((s) => ({ template_id: templateId, ...s })));
    if (subSaveErr) return toast('Đã lưu mẫu nhưng lỗi lưu BƯỚC TRÌNH: ' + subSaveErr.message, 'error');

    // Phòng ban được xem: xóa sạch rồi ghi lại, giống hai khối trên
    const viewerDepts = viewerBlock.get();
    await supabase.from('template_viewers').delete().eq('template_id', templateId);
    if (viewerDepts.length) {
      const { error: tvErr } = await supabase.from('template_viewers').insert(viewerDepts.map((d) => ({ template_id: templateId, department: d })));
      if (tvErr) return toast('Đã lưu mẫu nhưng lỗi lưu Phòng ban được xem: ' + tvErr.message, 'error');
    }

    toast('Đã lưu thay đổi mẫu hồ sơ', 'success');
    closeModal(modal, onClose);
  });
}

async function openCreateBudgetCatModal(onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo mã ngân sách mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã * (viết liền không dấu, vd NCC_ThepXayDung)</label><input type="text" id="fCode" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên đầy đủ *</label><input type="text" id="fName" class="form-input" placeholder="VD: Cung cấp thép xây dựng"></div>
      <div style="margin-bottom:13px"><label class="form-label">Nhóm chi phí</label><input type="text" id="fGroup" class="form-input" placeholder="VD: B.2"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu mã ngân sách</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const code = modal.querySelector('#fCode').value.trim();
    const name = modal.querySelector('#fName').value.trim();
    const group_code = modal.querySelector('#fGroup').value.trim() || null;
    if (!code || !name) return toast('Điền đủ Mã và Tên', 'error');
    loading(true);
    const { error } = await supabase.from('budget_categories').insert({ code, name, group_code });
    if (error) return toast('Lỗi lưu (có thể mã đã tồn tại): ' + error.message, 'error');
    toast('Đã tạo mã ngân sách mới', 'success');
    closeModal(modal, onClose);
  });
}

async function openEditBudgetCatModal(code, onClose) {
  const modal = ensureModal();
  const { data: cat } = await supabase.from('budget_categories').select('*').eq('code', code).single();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Mã ngân sách: ${code}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã (không đổi được)</label><input type="text" class="form-input" value="${code}" disabled style="background:var(--gray1)"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên đầy đủ</label><input type="text" id="fName" class="form-input" value="${cat?.name || ''}"></div>
      <div style="margin-bottom:13px"><label class="form-label">Nhóm chi phí</label><input type="text" id="fGroup" class="form-input" value="${cat?.group_code || ''}"></div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-danger" id="btnDelete">🗑️ Xóa mã này</button>
      <button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu thay đổi</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fName').value.trim();
    const group_code = modal.querySelector('#fGroup').value.trim() || null;
    if (!name) return toast('Điền tên', 'error');
    loading(true);
    const { error } = await supabase.from('budget_categories').update({ name, group_code }).eq('code', code);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');
    toast('Đã lưu thay đổi', 'success');
    closeModal(modal, onClose);
  });

  modal.querySelector('#btnDelete').addEventListener('click', async () => {
    if (!confirm(`Xóa mã ngân sách "${code}"? Chỉ xóa được nếu chưa dùng ở ngân sách/hợp đồng/bill nào.`)) return;
    loading(true);
    const { error } = await supabase.from('budget_categories').delete().eq('code', code);
    if (error) return toast(error.message, 'error');
    toast('Đã xóa mã ngân sách', 'success');
    closeModal(modal, onClose);
  });
}

async function openEditDeptModal(name, onClose) {
  const modal = ensureModal();
  const { data: holders } = await supabase
    .from('user_roles')
    .select('id, role_type, users(full_name, email)')
    .eq('department', name)
    .in('role_type', ['TruongPhongChucNang', 'PTGD']);
  const { data: staff } = await supabase
    .from('user_roles')
    .select('id, users(full_name, email)')
    .eq('department', name)
    .eq('role_type', 'ChuyenVienPhongBan');
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chọn người —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;
  const roleLabel = { TruongPhongChucNang: 'Trưởng phòng', PTGD: 'PTGD phụ trách' };

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Phòng ban: ${name}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Tên phòng ban</label><input type="text" id="fName" class="form-input" value="${name}"></div>
      <div style="font-size:11.5px;color:var(--gray4);margin-bottom:16px">Đổi tên ở đây sẽ tự cập nhật lại hết những chỗ đang dùng tên cũ (người dùng, mẫu hồ sơ) — không cần sửa tay từng nơi.</div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Người phụ trách phòng ban này</div>
      <div class="card" style="padding:12px 14px;margin-bottom:20px">
        <div id="holderList" style="margin-bottom:10px">
          ${(holders || []).length ? holders.map((h) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gray1);font-size:13px">
            <span><span class="code-chip">${roleLabel[h.role_type]}</span> ${h.users?.full_name} <span style="color:var(--gray4)">(${h.users?.email})</span></span>
            <span data-rm-holder="${h.id}" style="cursor:pointer;color:var(--red);font-size:12px">Gỡ</span>
          </div>`).join('') : '<div style="color:var(--gray4);font-size:12px">Chưa gán ai</div>'}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px">
          <select id="fHolderUser" class="form-input">${userOptions}</select>
          <select id="fHolderRole" class="form-input"><option value="TruongPhongChucNang">Trưởng phòng</option><option value="PTGD">PTGD phụ trách</option></select>
          <button class="btn btn-sm btn-secondary" id="btnAddHolder">+ Thêm</button>
        </div>
      </div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Chuyên viên phòng ban — có thể nhiều người cùng lúc</div>
      <div style="font-size:11.5px;color:var(--gray4);margin-bottom:8px">Bắt buộc phải gán mới trình được hồ sơ dưới danh nghĩa phòng này.</div>
      <div class="card" style="padding:12px 14px">
        <div id="staffList" style="margin-bottom:10px">
          ${(staff || []).length ? staff.map((s) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gray1);font-size:13px">
            <span>${s.users?.full_name} <span style="color:var(--gray4)">(${s.users?.email})</span></span>
            <span data-rm-staff="${s.id}" style="cursor:pointer;color:var(--red);font-size:12px">Gỡ</span>
          </div>`).join('') : '<div style="color:var(--gray4);font-size:12px">Chưa có chuyên viên nào — chưa ai trình được hồ sơ cho phòng này.</div>'}
        </div>
        <div style="display:flex;gap:8px">
          <select id="fStaffUser" class="form-input">${userOptions}</select>
          <button class="btn btn-sm btn-secondary" id="btnAddStaff">+ Thêm chuyên viên</button>
        </div>
      </div>
    </div>
    <div class="panel-footer">
      <button class="btn btn-danger" id="btnDelete">🗑️ Xóa phòng ban</button>
      <button class="btn btn-primary" id="btnSave" style="margin-left:auto">💾 Lưu tên mới</button>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnAddHolder').addEventListener('click', async () => {
    const userId = modal.querySelector('#fHolderUser').value;
    const role_type = modal.querySelector('#fHolderRole').value;
    if (!userId) return toast('Chọn người trước', 'error');
    loading(true);
    const { error } = await supabase.from('user_roles').insert({ user_id: userId, role_type, department: name });
    if (error) return toast('Lỗi (có thể đã gán rồi): ' + error.message, 'error');
    toast('Đã thêm người phụ trách', 'success');
    openEditDeptModal(name, onClose);
  });

  modal.querySelectorAll('[data-rm-holder]').forEach((el) =>
    el.addEventListener('click', async () => {
      await supabase.from('user_roles').delete().eq('id', el.dataset.rmHolder);
      toast('Đã gỡ', 'success');
      openEditDeptModal(name, onClose);
    }),
  );

  modal.querySelector('#btnAddStaff').addEventListener('click', async () => {
    const userId = modal.querySelector('#fStaffUser').value;
    if (!userId) return toast('Chọn người trước', 'error');
    loading(true);
    const { error } = await supabase.from('user_roles').insert({ user_id: userId, role_type: 'ChuyenVienPhongBan', department: name });
    if (error) return toast('Lỗi (có thể đã gán rồi): ' + error.message, 'error');
    toast('Đã thêm chuyên viên', 'success');
    openEditDeptModal(name, onClose);
  });

  modal.querySelectorAll('[data-rm-staff]').forEach((el) =>
    el.addEventListener('click', async () => {
      await supabase.from('user_roles').delete().eq('id', el.dataset.rmStaff);
      toast('Đã gỡ', 'success');
      openEditDeptModal(name, onClose);
    }),
  );

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const newName = modal.querySelector('#fName').value.trim();
    if (!newName) return toast('Điền tên phòng ban', 'error');
    if (newName === name) return closeModal(modal, onClose);
    loading(true);
    const { error } = await supabase.from('departments').update({ name: newName }).eq('name', name);
    if (error) return toast('Lỗi đổi tên (có thể tên mới đã tồn tại): ' + error.message, 'error');
    toast('Đã đổi tên phòng ban', 'success');
    closeModal(modal, onClose);
  });

  modal.querySelector('#btnDelete').addEventListener('click', async () => {
    if (!confirm(`Xóa phòng ban "${name}"? Chỉ xóa được nếu chưa ai/mẫu hồ sơ nào đang dùng.`)) return;
    loading(true);
    const { error } = await supabase.from('departments').delete().eq('name', name);
    if (error) return toast(error.message, 'error');
    toast('Đã xóa phòng ban', 'success');
    closeModal(modal, onClose);
  });
}

// Các vai trò còn lại ngoài CHT/GĐDA/PTGD (những vai trò này đích danh theo kiểu
// "danh sách nhiều người", không phải "1 người thay 1 người")
const OTHER_PROJECT_ROLES = ['QS', 'TGD', 'ChuyenVienPhongBan', 'TruongPhongChucNang', 'PhapChe_CV', 'PhapChe_TP', 'KeToan_Vien', 'KeToan_Truong', 'QLCPHD_CV', 'QLCPHD_TP'];

async function openProjectAssignModal(projectId, projectName, currentUser, onClose) {
  const modal = ensureModal();
  const today = new Date().toISOString().slice(0, 10);
  const isAdmin = (currentUser.roles || []).includes('Admin');
  const { data: projectFull } = await supabase.from('projects').select('*').eq('id', projectId).single();
  const { data: assignments, error: assignErr } = await supabase
    .from('project_role_assignments')
    .select('id, role_type, user_id, effective_from, users!user_id(full_name, email)')
    .eq('project_id', projectId)
    .or(`effective_to.is.null,effective_to.gte.${today}`); // khớp đúng logic "còn hiệu lực" đang dùng để định tuyến — không chỉ mỗi effective_to để trống
  if (assignErr) console.error('Lỗi tải người phụ trách:', assignErr);
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chọn người —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;

  const roleLabel = { CHT: 'Chỉ huy trưởng', GDDA: 'Giám đốc dự án', PTGD: 'Phó Tổng Giám đốc' };
  const currentByRole = {};
  const otherAssignments = [];
  (assignments || []).forEach((a) => {
    if (a.role_type in roleLabel) currentByRole[a.role_type] = a;
    else otherAssignments.push(a);
  });

  const rows = Object.keys(roleLabel)
    .map((role) => {
      const cur = currentByRole[role];
      return `<div style="margin-bottom:14px">
      <label class="form-label">${roleLabel[role]}</label>
      <div style="font-size:12.5px;color:${cur ? 'var(--gray8)' : 'var(--gray4)'};margin-bottom:6px">${cur ? `Hiện tại: <b>${cur.users?.full_name}</b> (${cur.users?.email}) — từ ${new Date(cur.effective_from).toLocaleDateString('vi-VN')}` : 'Chưa gán'}</div>
      <div style="display:flex;gap:8px">
        <select class="form-input reassign-select" data-role="${role}" style="flex:1">
          <option value="">— Chọn người —</option>
          <option value="__EMPTY__">— Để trống (bỏ vai trò này, coi như không có ai) —</option>
          ${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}
        </select>
        <button class="btn btn-sm btn-secondary reassign-btn" data-role="${role}">Đổi</button>
      </div>
    </div>`;
    })
    .join('');

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Người phụ trách dự án — ${projectName}</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      ${isAdmin ? `
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Thông tin dự án (chỉ Admin sửa được)</div>
      <div class="card" style="padding:12px 14px;margin-bottom:20px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label class="form-label">Mã viết tắt</label><input type="text" id="fProjCode" class="form-input" value="${projectFull?.code || ''}"></div>
          <div><label class="form-label">Tên dự án</label><input type="text" id="fProjName" class="form-input" value="${projectFull?.name || ''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label class="form-label">Chủ đầu tư</label><input type="text" id="fProjInvestor" class="form-input" value="${projectFull?.investor || ''}"></div>
          <div><label class="form-label">Địa điểm</label><input type="text" id="fProjLocation" class="form-input" value="${projectFull?.location || ''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div><label class="form-label">Loại hình</label><input type="text" id="fProjType" class="form-input" value="${projectFull?.project_type || ''}"></div>
          <div><label class="form-label">Số căn</label><input type="number" id="fProjUnitCount" class="form-input" value="${projectFull?.unit_count ?? ''}"></div>
        </div>
        <button class="btn btn-sm btn-primary" id="btnSaveProjectInfo">💾 Lưu thông tin dự án</button>
      </div>` : ''}
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:16px">ℹ️ Đổi người (CHT/GĐDA/PTGD) sẽ tự động chuyển giao hồ sơ đang chờ duyệt của dự án này sang người mới (nếu có), không bị treo. Chọn "Để trống" sẽ bỏ hẳn người đang giữ vai trò đó — bước duyệt tương ứng của dự án này sẽ tự động bị bỏ qua.</div>
      ${rows}
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5);margin-top:20px">Các vai trò khác — đích danh theo dự án (nhiều người/vai trò cùng lúc)</div>
      <div style="font-size:11.5px;color:var(--gray4);margin-bottom:8px">QS bắt buộc phải gán mới trình được hồ sơ cho dự án này. Các vai trò khác (Pháp chế, Kế toán, QLCP&HĐ...) không bắt buộc — nếu không chỉ đích danh ở đây, hồ sơ dự án đó tự động gửi cho cả nhóm giữ vai trò đó.</div>
      <div class="card" style="padding:12px 14px">
        <div id="otherRolesList" style="margin-bottom:10px">
          ${otherAssignments.length ? otherAssignments.map((a) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--gray1);font-size:13px">
            <span><span class="code-chip">${a.role_type}</span> ${a.users?.full_name} <span style="color:var(--gray4)">(${a.users?.email})</span></span>
            <span data-rm-other="${a.id}" data-role-type="${a.role_type}" style="cursor:pointer;color:var(--red);font-size:12px">Gỡ</span>
          </div>`).join('') : '<div style="color:var(--gray4);font-size:12px">Chưa đích danh thêm ai.</div>'}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px">
          <select id="fOtherRole" class="form-input">${OTHER_PROJECT_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
          <select id="fOtherUser" class="form-input">${userOptions}</select>
          <button class="btn btn-sm btn-secondary" id="btnAddOther">+ Thêm</button>
        </div>
      </div>
    </div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSaveProjectInfo')?.addEventListener('click', async () => {
    const code = modal.querySelector('#fProjCode').value.trim();
    const name = modal.querySelector('#fProjName').value.trim();
    const investor = modal.querySelector('#fProjInvestor').value.trim() || null;
    const location = modal.querySelector('#fProjLocation').value.trim() || null;
    const project_type = modal.querySelector('#fProjType').value.trim() || null;
    const unit_countRaw = modal.querySelector('#fProjUnitCount').value.trim();
    const unit_count = unit_countRaw ? Number(unit_countRaw) : null;
    if (!code || !name) return toast('Điền đủ Mã và Tên dự án', 'error');

    loading(true);
    const { error } = await supabase.from('projects').update({ code, name, investor, location, project_type, unit_count }).eq('id', projectId);
    if (error) return toast('Lỗi lưu (có thể mã đã trùng): ' + error.message, 'error');
    toast('Đã lưu thông tin dự án', 'success');
    openProjectAssignModal(projectId, name, currentUser, onClose);
  });

  modal.querySelectorAll('.reassign-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const role = btn.dataset.role;
      const select = modal.querySelector(`.reassign-select[data-role="${role}"]`);
      const newUserId = select.value;
      if (!newUserId) return toast('Chọn người trước khi đổi', 'error');

      loading(true);
      if (newUserId === '__EMPTY__') {
        // Để trống — chỉ kết thúc phân công hiện tại (nếu có), KHÔNG gán ai thay
        // thế. Từ hồ sơ mới trở đi, vai trò này coi như "không có ai" ở dự án này
        // -> tự động bỏ qua bước tương ứng, đúng cơ chế đã có sẵn. Dùng effective_to
        // = HÔM QUA (không phải hôm nay) — khớp đúng cách fn_reassign_project_role
        // đang làm, để có hiệu lực NGAY LẬP TỨC (câu truy vấn "còn hiệu lực" ở khắp
        // nơi dùng >= hôm nay, nên nếu đặt = hôm nay thì vẫn còn tính là hiệu lực
        // cho tới hết hôm nay, phải qua ngày mai mới thật sự trống).
        const cur = currentByRole[role];
        if (!cur) {
          toast('Vai trò này vốn đã đang để trống rồi', 'info');
          return;
        }
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const { error } = await supabase.from('project_role_assignments').update({ effective_to: yesterday }).eq('id', cur.id);
        if (error) return toast('Lỗi: ' + error.message, 'error');
        toast(`Đã bỏ ${roleLabel[role]} — không gán ai thay thế, hồ sơ mới sẽ tự bỏ qua bước này`, 'success');
        openProjectAssignModal(projectId, projectName, currentUser, onClose);
        return;
      }

      const { data, error } = await supabase.rpc('fn_reassign_project_role', {
        p_project_id: projectId, p_role_type: role, p_new_user_id: newUserId, p_actor_id: currentUser.id,
      });
      if (error) return toast('Lỗi: ' + error.message, 'error');
      if (data.old_user_id) {
        toast(`Đã thay ${roleLabel[role]} — chuyển giao ${data.transferred_count} hồ sơ đang chờ duyệt sang người mới`, 'success');
      } else {
        toast(`Đã gán ${roleLabel[role]}`, 'success');
      }
      openProjectAssignModal(projectId, projectName, currentUser, onClose);
    }),
  );

  modal.querySelector('#btnAddOther').addEventListener('click', async () => {
    const userId = modal.querySelector('#fOtherUser').value;
    const role_type = modal.querySelector('#fOtherRole').value;
    if (!userId) return toast('Chọn người trước', 'error');
    loading(true);
    const { error } = await supabase.from('project_role_assignments').insert({
      project_id: projectId, user_id: userId, role_type, effective_from: new Date().toISOString().slice(0, 10),
    });
    if (error) return toast('Lỗi (có thể đã gán rồi): ' + error.message, 'error');

    // Hồ sơ nào đang chờ đúng vai trò này ở bước hiện tại (chưa ai duyệt) sẽ tự cập
    // nhật sang đúng người mới nhất — hồ sơ đã duyệt rồi giữ nguyên, không đụng tới
    const { data: resyncCount } = await supabase.rpc('fn_resync_pending_assignments', { p_project_id: projectId, p_role_type: role_type });
    toast(`Đã thêm${resyncCount ? ` — cập nhật lại ${resyncCount} hồ sơ đang chờ duyệt` : ''}`, 'success');
    openProjectAssignModal(projectId, projectName, currentUser, onClose);
  });

  modal.querySelectorAll('[data-rm-other]').forEach((el) =>
    el.addEventListener('click', async () => {
      loading(true);
      const roleType = el.dataset.roleType;
      await supabase.from('project_role_assignments').update({ effective_to: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }).eq('id', el.dataset.rmOther);

      let resyncCount = 0;
      if (roleType) {
        const { data } = await supabase.rpc('fn_resync_pending_assignments', { p_project_id: projectId, p_role_type: roleType });
        resyncCount = data || 0;
      }
      toast(`Đã gỡ${resyncCount ? ` — cập nhật lại ${resyncCount} hồ sơ đang chờ duyệt (rơi về cả nhóm nếu chưa ai đích danh khác)` : ''}`, 'success');
      openProjectAssignModal(projectId, projectName, currentUser, onClose);
    }),
  );
}

async function openCreateDeptModal(onClose) {
  const modal = ensureModal();
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chưa gán, làm sau —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo phòng ban mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Tên phòng ban *</label><input type="text" id="fDeptName" class="form-input" placeholder="VD: Thiết bị"></div>
      <div style="font-size:11.5px;color:var(--gray4);margin-bottom:16px">Đặt tên ngắn gọn, thống nhất — tên này sẽ hiện trong danh sách chọn khi gán vai trò cho người dùng và khi tạo Mẫu hồ sơ.</div>
      <div style="margin-bottom:13px"><label class="form-label">Trưởng phòng (không bắt buộc — có thể gán sau)</label>
        <select id="fTruongPhong" class="form-input">${userOptions}</select></div>
      <div style="margin-bottom:13px"><label class="form-label">PTGD phụ trách phòng này (không bắt buộc)</label>
        <select id="fPtgd" class="form-input">${userOptions}</select>
        <div style="font-size:11px;color:var(--gray4);margin-top:4px">Chỉ áp dụng cho luồng duyệt Mẫu hồ sơ "Phòng ban" — PTGD công trường vẫn phân theo dự án như cũ.</div></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu phòng ban</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const name = modal.querySelector('#fDeptName').value.trim();
    const truongPhongId = modal.querySelector('#fTruongPhong').value;
    const ptgdId = modal.querySelector('#fPtgd').value;
    if (!name) return toast('Điền tên phòng ban', 'error');

    loading(true);
    const { error } = await supabase.from('departments').insert({ name });
    if (error) return toast('Lỗi lưu (có thể phòng ban đã tồn tại): ' + error.message, 'error');

    if (truongPhongId) {
      await supabase.from('user_roles').insert({ user_id: truongPhongId, role_type: 'TruongPhongChucNang', department: name }).select();
    }
    if (ptgdId) {
      await supabase.from('user_roles').insert({ user_id: ptgdId, role_type: 'PTGD', department: name }).select();
    }

    toast('Đã tạo phòng ban mới' + (truongPhongId || ptgdId ? ' và gán người phụ trách' : ''), 'success');
    closeModal(modal, onClose);
  });
}

async function openCreateProjectModal(onClose) {
  const modal = ensureModal();
  const { data: users } = await supabase.from('users').select('id, full_name, email').eq('is_active', true).order('full_name');
  const userOptions = `<option value="">— Chưa gán, làm sau —</option>${(users || []).map((u) => `<option value="${u.id}">${u.full_name} (${u.email})</option>`).join('')}`;

  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Tạo dự án mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:13px"><label class="form-label">Mã dự án * (dùng trong số hợp đồng, viết liền không dấu, vd VEGACITY)</label><input type="text" id="fCode" class="form-input" style="text-transform:uppercase"></div>
      <div style="margin-bottom:13px"><label class="form-label">Tên dự án *</label><input type="text" id="fName" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Chủ đầu tư (CĐT)</label><input type="text" id="fInvestor" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Địa điểm</label><input type="text" id="fLocation" class="form-input"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:13px">
        <div><label class="form-label">Loại hình</label><input type="text" id="fType" class="form-input" placeholder="VD: Villa, Liền kề"></div>
        <div><label class="form-label">Số lượng căn</label><input type="number" id="fUnits" class="form-input"></div>
      </div>
      <div style="margin-bottom:13px"><label class="form-label">Ngày khởi công</label><input type="date" id="fStart" class="form-input"></div>
      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Người phụ trách (không bắt buộc — có thể gán sau)</div>
      <div class="card" style="padding:12px 14px">
        <div style="margin-bottom:10px"><label class="form-label">Chỉ huy trưởng (CHT)</label><select id="fCht" class="form-input">${userOptions}</select></div>
        <div style="margin-bottom:10px"><label class="form-label">Giám đốc dự án (GĐDA)</label><select id="fGdda" class="form-input">${userOptions}</select></div>
        <div><label class="form-label">Phó Tổng Giám đốc (PTGD)</label><select id="fPtgd" class="form-input">${userOptions}</select></div>
      </div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu dự án</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const code = modal.querySelector('#fCode').value.trim().toUpperCase();
    const name = modal.querySelector('#fName').value.trim();
    if (!code || !name) return toast('Điền đủ Mã dự án và Tên dự án', 'error');

    loading(true);
    const { data: newProject, error } = await supabase.from('projects').insert({
      code, name,
      investor: modal.querySelector('#fInvestor').value.trim() || null,
      location: modal.querySelector('#fLocation').value.trim() || null,
      project_type: modal.querySelector('#fType').value.trim() || null,
      unit_count: modal.querySelector('#fUnits').value ? Number(modal.querySelector('#fUnits').value) : null,
      start_date: modal.querySelector('#fStart').value || null,
      status: 'active',
    }).select('id').single();
    if (error) return toast('Lỗi lưu dự án (mã có thể đã tồn tại): ' + error.message, 'error');

    const assignments = [
      { sel: '#fCht', role: 'CHT' },
      { sel: '#fGdda', role: 'GDDA' },
      { sel: '#fPtgd', role: 'PTGD' },
    ];
    let assignedCount = 0;
    for (const a of assignments) {
      const userId = modal.querySelector(a.sel).value;
      if (userId) {
        await supabase.from('project_role_assignments').insert({ project_id: newProject.id, user_id: userId, role_type: a.role, effective_from: new Date().toISOString().slice(0, 10) });
        assignedCount++;
      }
    }

    toast('Đã tạo dự án mới' + (assignedCount ? ` và gán ${assignedCount} người phụ trách` : ''), 'success');
    closeModal(modal, onClose);
  });
}

async function openUserDetail(id, currentUser, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box"><div class="empty-note">Đang tải…</div></div>`;
  showModal(modal, onClose);

  const { data: u } = await supabase.from('users').select('*').eq('id', id).single();
  const { data: myRoles } = await supabase.from('user_roles').select('id, role_type, department').eq('user_id', id);
  const { data: departments } = await supabase.from('departments').select('name').order('name');

  const box = modal.querySelector('.panel-box');
  box.innerHTML = `
    <div class="panel-header"><div><div>${u.full_name}</div><div class="meta">${u.email}${u.job_title ? ' · ' + u.job_title : ''}</div></div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="margin-bottom:16px">
        <label class="form-label">Trạng thái tài khoản</label>
        <button class="btn btn-sm ${u.is_active ? 'btn-danger' : 'btn-secondary'}" id="btnToggleActive">${u.is_active ? '🔒 Khóa tài khoản' : '✓ Kích hoạt lại'}</button>
      </div>

      <div style="margin-bottom:16px"><label class="form-label">Chức danh (không bắt buộc — chỉ để tham khảo, không ảnh hưởng luồng duyệt)</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="fJobTitle" class="form-input" value="${u.job_title || ''}" placeholder="VD: Phó phòng Vật tư">
          <button class="btn btn-sm btn-secondary" id="btnSaveJobTitle">Lưu</button>
        </div>
      </div>

      <div class="card-title" style="font-size:12px;text-transform:uppercase;color:var(--gray5)">Vai trò hệ thống</div>
      <div class="card">
        <div id="roleList" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          ${(myRoles || []).map((r) => `<span class="code-chip">${r.role_type}${r.department ? ' — ' + r.department : ''} <span data-rm-role="${r.id}" style="cursor:pointer;color:var(--red);font-weight:700;margin-left:3px">✕</span></span>`).join('') || '<span style="color:var(--gray4);font-size:12px">Chưa có vai trò nào</span>'}
        </div>
        <div style="display:flex;gap:8px">
          <select id="fAddRole" class="form-input">${ALL_ROLES.map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
          <select id="fAddRoleDept" class="form-input" style="max-width:200px">
            <option value="">— Không thuộc phòng ban —</option>
            ${(departments || []).map((d) => `<option value="${d.name}">${d.name}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-secondary" id="btnAddRole">+ Thêm</button>
        </div>
      </div>

    </div>`;

  box.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  box.querySelector('#btnSaveJobTitle').addEventListener('click', async () => {
    const job_title = box.querySelector('#fJobTitle').value.trim() || null;
    loading(true);
    const { error } = await supabase.from('users').update({ job_title }).eq('id', id);
    if (error) return toast('Lỗi lưu: ' + error.message, 'error');
    toast('Đã lưu chức danh', 'success');
    openUserDetail(id, currentUser, onClose);
  });

  box.querySelector('#btnToggleActive').addEventListener('click', async () => {
    loading(true);
    const { error } = await supabase.from('users').update({ is_active: !u.is_active }).eq('id', id);
    if (error) return toast('Lỗi: ' + error.message, 'error');
    toast(u.is_active ? 'Đã khóa tài khoản' : 'Đã kích hoạt lại', 'success');
    openUserDetail(id, currentUser, onClose);
  });

  box.querySelector('#btnAddRole').addEventListener('click', async () => {
    const role_type = box.querySelector('#fAddRole').value;
    const department = box.querySelector('#fAddRoleDept').value.trim() || null;
    const { error } = await supabase.from('user_roles').insert({ user_id: id, role_type, department });
    if (error) return toast('Lỗi (có thể vai trò này đã có): ' + error.message, 'error');
    toast('Đã thêm vai trò', 'success');
    openUserDetail(id, currentUser, onClose);
  });

  box.querySelectorAll('[data-rm-role]').forEach((el) =>
    el.addEventListener('click', async () => {
      await supabase.from('user_roles').delete().eq('id', el.dataset.rmRole);
      toast('Đã xóa vai trò', 'success');
      openUserDetail(id, currentUser, onClose);
    }),
  );
}

async function openCreateUserModal(currentUser, onClose) {
  const modal = ensureModal();
  modal.innerHTML = `<div class="panel-box">
    <div class="panel-header"><div>Thêm người dùng mới</div><button class="panel-close" id="pClose">✕</button></div>
    <div class="panel-body">
      <div style="font-size:12px;background:var(--lblue);color:#1D4ED8;padding:9px 12px;border-radius:7px;margin-bottom:14px">ℹ️ Nhập đúng email Outlook công ty — người này đăng nhập bằng chính email đó, không có mật khẩu riêng.</div>
      <div style="margin-bottom:13px"><label class="form-label">Email Outlook công ty *</label><input type="email" id="fEmail" class="form-input" placeholder="ten.nhanvien@velaec.vn"></div>
      <div style="margin-bottom:13px"><label class="form-label">Họ tên *</label><input type="text" id="fName" class="form-input"></div>
      <div style="margin-bottom:13px"><label class="form-label">Chức danh (không bắt buộc — chỉ để tham khảo, không ảnh hưởng luồng duyệt)</label><input type="text" id="fJobTitle" class="form-input" placeholder="VD: Phó phòng Vật tư"></div>
      <div style="margin-bottom:13px"><label class="form-label">Điện thoại</label><input type="text" id="fPhone" class="form-input"></div>
    </div>
    <div class="panel-footer"><button class="btn btn-primary" id="btnSave" style="margin-left:auto">Lưu — gán vai trò ở bước sau</button></div>
  </div>`;
  showModal(modal, onClose);
  modal.querySelector('#pClose').addEventListener('click', () => closeModal(modal, onClose));

  modal.querySelector('#btnSave').addEventListener('click', async () => {
    const email = modal.querySelector('#fEmail').value.trim();
    const full_name = modal.querySelector('#fName').value.trim();
    const job_title = modal.querySelector('#fJobTitle').value.trim() || null;
    const phone = modal.querySelector('#fPhone').value.trim() || null;
    if (!email || !full_name) return toast('Điền đủ email và họ tên', 'error');

    loading(true);
    const { error } = await supabase.from('users').insert({ email, full_name, job_title, phone });
    if (error) return toast('Lỗi (có thể email đã tồn tại): ' + error.message, 'error');
    toast('Đã thêm người dùng — bấm vào tên họ để gán vai trò', 'success');
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
