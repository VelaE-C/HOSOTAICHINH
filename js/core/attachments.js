// ============================================================
// attachments.js — Đính kèm file (PDF/Word/Excel/ảnh), tối đa 10 file/hồ sơ.
// Dùng chung cho hopdong.js, bill.js, totrinh.js — gọi renderAttachments()
// vào đúng 1 <div id="..."> trong panel chi tiết.
// Bucket private — mở file qua signed URL (link tạm 1 giờ), không lộ đường dẫn thật.
// ============================================================
import { supabase } from './config.js';
import { toast, loading } from './utils.js';

const MAX_FILES = 10;
const BUCKET = 'attachments';

function fileIcon(name) {
  if (/\.pdf$/i.test(name)) return '📕';
  if (/\.(xlsx|xls|csv)$/i.test(name)) return '📗';
  if (/\.(docx?|)$/i.test(name) && /\.docx?$/i.test(name)) return '📘';
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return '🖼️';
  return '📄';
}
function fmtSize(kb) {
  if (kb == null) return '';
  return kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

// Gọi hàm này để vẽ + gắn toàn bộ chức năng vào 1 khung <div>
// canEdit = false -> chỉ xem/tải file, ẩn hẳn nút Thêm/Xóa (hồ sơ đang duyệt hoặc đã hoàn tất)
export async function renderAttachments(container, ownerType, ownerId, currentUserId, canEdit = true) {
  await refresh();

  async function refresh() {
    const { data: files, error } = await supabase
      .from('attachments')
      .select('id, file_name, file_url, file_size_kb, uploaded_by, uploaded_at')
      .eq('owner_type', ownerType)
      .eq('owner_id', ownerId)
      .order('uploaded_at', { ascending: false });

    if (error) {
      container.innerHTML = `<div class="empty-note">⚠️ Không tải được danh sách file: ${error.message}</div>`;
      return;
    }

    const count = files?.length || 0;
    container.innerHTML = `
      ${!canEdit ? `<div style="font-size:11.5px;color:var(--gray4);margin-bottom:8px">🔒 Hồ sơ đang khóa (đang duyệt hoặc đã hoàn tất) — chỉ xem, không thêm/xóa được.</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        ${count ? files.map((f) => `
          <span class="linked-chip" style="background:var(--gray1);color:var(--gray7);cursor:pointer" data-open-file="${f.id}" data-path="${f.file_url}">
            ${fileIcon(f.file_name)} ${f.file_name}
            <span style="color:var(--gray4);font-weight:400;font-size:11px">(${fmtSize(f.file_size_kb)})</span>
            ${canEdit && f.uploaded_by === currentUserId ? `<span data-del-file="${f.id}" data-path="${f.file_url}" style="cursor:pointer;color:var(--red);font-weight:700;margin-left:2px">✕</span>` : ''}
          </span>`).join('') : '<span style="color:var(--gray4);font-size:12px">Chưa có file đính kèm</span>'}
      </div>
      ${canEdit ? `
      <input type="file" id="fileInput" style="display:none" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg">
      <button class="btn btn-sm btn-secondary" id="btnAddFile" ${count >= MAX_FILES ? 'disabled' : ''}>+ Thêm file (PDF, Word, Excel, ảnh)</button>
      <div style="font-size:11px;color:var(--gray4);margin-top:5px">${count}/${MAX_FILES} file — tối đa ${MAX_FILES} file mỗi hồ sơ.</div>` : ''}
    `;

    container.querySelector('#btnAddFile')?.addEventListener('click', () => container.querySelector('#fileInput').click());
    container.querySelector('#fileInput')?.addEventListener('change', async (e) => {
      const chosen = [...e.target.files];
      if (count + chosen.length > MAX_FILES) {
        toast(`Chỉ được tối đa ${MAX_FILES} file — hiện có ${count}, chỉ thêm được ${MAX_FILES - count} nữa`, 'error');
        e.target.value = '';
        return;
      }
      for (const file of chosen) await uploadOne(file);
      e.target.value = '';
      refresh();
    });

    container.querySelectorAll('[data-open-file]').forEach((el) =>
      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-del-file]')) return; // bấm nút xóa thì không mở file
        const { data, error: signErr } = await supabase.storage.from(BUCKET).createSignedUrl(el.dataset.path, 3600);
        if (signErr) return toast('Không mở được file: ' + signErr.message, 'error');
        window.open(data.signedUrl, '_blank');
      }),
    );

    container.querySelectorAll('[data-del-file]').forEach((el) =>
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('Xóa file này khỏi hồ sơ?')) return;
        await supabase.storage.from(BUCKET).remove([el.dataset.path]);
        await supabase.from('attachments').delete().eq('id', el.dataset.delFile);
        toast('Đã xóa file', 'success');
        refresh();
      }),
    );
  }

  async function uploadOne(file) {
    if (file.size > 20 * 1024 * 1024) {
      toast(`File "${file.name}" vượt quá 20MB, không tải lên được`, 'error');
      return;
    }
    loading(true, `Đang tải lên: ${file.name}`);
    const path = `${ownerType}/${ownerId}/${Date.now()}_${file.name.replace(/[^\w.\-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file);
    if (upErr) {
      toast(`Lỗi tải file "${file.name}": ${upErr.message}`, 'error');
      return;
    }
    const { error: insErr } = await supabase.from('attachments').insert({
      owner_type: ownerType,
      owner_id: ownerId,
      file_name: file.name,
      file_url: path,
      file_size_kb: Math.round(file.size / 1024),
      uploaded_by: currentUserId,
    });
    if (insErr) {
      toast(`Đã tải file lên nhưng lỗi ghi nhận: ${insErr.message}`, 'error');
      return;
    }
    toast(`Đã thêm "${file.name}"`, 'success');
  }
}

// ============================================================
// DÀNH RIÊNG CHO FORM TẠO MỚI — chọn file giữ tạm trên trình duyệt
// (CHƯA upload), rồi gọi uploadStagedFiles() upload hàng loạt SAU KHI
// hồ sơ đã được tạo thật (có ownerId), cùng lúc với "Lưu nháp"/"Trình duyệt"
// ============================================================

// Gọi vào 1 khung <div> trong form Tạo mới. Trả về { getFiles() } để đọc lại
// danh sách File đã chọn lúc lưu.
export function renderFilePicker(wrapEl) {
  let staged = [];

  function refresh() {
    wrapEl.innerHTML = `
      <div class="staged-file-list" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        ${staged.length ? staged.map((f, i) => `
          <span class="linked-chip" style="background:var(--gray1);color:var(--gray7)">
            ${fileIcon(f.name)} ${f.name}
            <span style="color:var(--gray4);font-weight:400;font-size:11px">(${fmtSize(Math.round(f.size / 1024))})</span>
            <span data-rm-staged="${i}" style="cursor:pointer;color:var(--red);font-weight:700;margin-left:2px">✕</span>
          </span>`).join('') : '<span style="color:var(--gray4);font-size:12px">Chưa chọn file nào</span>'}
      </div>
      <input type="file" id="filePickerInput" style="display:none" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg">
      <button type="button" class="btn btn-sm btn-secondary" id="btnPickFiles" ${staged.length >= MAX_FILES ? 'disabled' : ''}>+ Chọn file (PDF, Word, Excel, ảnh)</button>
      <div style="font-size:11px;color:var(--gray4);margin-top:5px">${staged.length}/${MAX_FILES} file đã chọn — sẽ tải lên khi bấm Lưu nháp/Trình duyệt, không phải ngay bây giờ.</div>
    `;

    wrapEl.querySelector('#btnPickFiles').addEventListener('click', () => wrapEl.querySelector('#filePickerInput').click());
    wrapEl.querySelector('#filePickerInput').addEventListener('change', (e) => {
      const chosen = [...e.target.files];
      for (const f of chosen) {
        if (staged.length >= MAX_FILES) {
          toast(`Chỉ được tối đa ${MAX_FILES} file`, 'error');
          break;
        }
        if (f.size > 20 * 1024 * 1024) {
          toast(`File "${f.name}" vượt quá 20MB, bỏ qua`, 'error');
          continue;
        }
        staged.push(f);
      }
      e.target.value = '';
      refresh();
    });
    wrapEl.querySelectorAll('[data-rm-staged]').forEach((el) =>
      el.addEventListener('click', () => {
        staged.splice(Number(el.dataset.rmStaged), 1);
        refresh();
      }),
    );
  }

  refresh();
  return { getFiles: () => staged };
}

// Gọi SAU KHI hồ sơ đã tạo thành công (có ownerId thật) — upload hàng loạt
// các file đã chọn tạm ở trên. Lỗi từng file không chặn các file còn lại.
export async function uploadStagedFiles(files, ownerType, ownerId, uploaderId) {
  if (!files || !files.length) return;
  loading(true, `Đang tải lên ${files.length} file đính kèm…`);
  for (const file of files) {
    const path = `${ownerType}/${ownerId}/${Date.now()}_${file.name.replace(/[^\w.\-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file);
    if (upErr) {
      toast(`Lỗi tải file "${file.name}": ${upErr.message}`, 'error');
      continue;
    }
    const { error: insErr } = await supabase.from('attachments').insert({
      owner_type: ownerType,
      owner_id: ownerId,
      file_name: file.name,
      file_url: path,
      file_size_kb: Math.round(file.size / 1024),
      uploaded_by: uploaderId,
    });
    if (insErr) toast(`Đã tải "${file.name}" lên nhưng lỗi ghi nhận: ${insErr.message}`, 'error');
  }
}
