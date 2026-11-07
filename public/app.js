import { buildInsights, insightsAreCurrent, transcriptFingerprint } from './insights.js';
import { createExport } from './exports.js';
import { reportSnapshot, reportFilename, reportStatus } from './reports.js';
import { selectedClipRange, formatClipTime } from './clips.js';
import { ClipEditor } from './clip-editor.js';
import { RecordingDialog } from './recording-dialog.js';
import { BatchQueue, MAX_BATCH_FILES, audioFileError } from './batch-queue.js';
import { BackupDialog } from './backup-dialog.js';
import { SubtitleDialog } from './subtitle-dialog.js';
import { HistoryDialog } from './history-dialog.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
const colors = ['#7472e9','#ec8068','#dcb151','#44b998','#5d9bd7','#cc79bd'];
function readStorage(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
const state = { project:null, projects:[], time:0, activeTab:'transcript', speaker:'all', query:'', confidence:true,
  editing:false, usingClean:false, job:null, polling:null, generating:null, saveChain:Promise.resolve(), saveCount:0, saveFailed:false,
  options:readStorage('audiokit-options',{model:'base',language:'auto',numSpeakers:0,noiseStrength:'standard'}),
  exports:readStorage('audiokit-exports',[]), speakerEdit:null, notePrefix:'', clipSelecting:false, clipAnchor:null, clipEnd:null, reportExporting:null, batch:null };
const audio = $('#audioElement');
const icons = {
  play:'<path d="m9 5 10 7-10 7z"/>', pause:'<path d="M9 5v14M15 5v14"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  folder:'<path d="M3 7V5h7l2 3h9v12H3z"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  templates:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12"/>',
  settings:'<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
  bell:'<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4"/>',
  volume:'<path d="m11 4-6 5H2v6h3l6 5zM15 8c3 2 3 6 0 8M18 5c5 4 5 10 0 14"/>',
  muted:'<path d="m11 4-6 5H2v6h3l6 5zM16 9l6 6m0-6-6 6"/>',
  wave:'<path d="M4 9v6M8 5v14M12 8v8M16 3v18M20 9v6"/>',
  arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  scissors:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 12 12M8 16 20 4"/>',
  mic:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.wave}</svg>`;
$$('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });
const clipEditor = new ClipEditor({getProject:()=>state.project,mainAudio:audio,toast,onExport:recordExport});
const recordingDialog = new RecordingDialog({dialog:$('#recordingModal'),mainAudio:audio,toast,
  upload:async file=>{await state.saveChain;const form=new FormData();form.append('audio',file);return api('/api/projects',{method:'POST',body:form});},
  onSaved:async project=>{await openProject(project.id);await refreshProjects();},
});

function formatTime(value) {
  const safe = Math.floor(Math.max(0,Number(value)||0));
  const hours = Math.floor(safe/3600); const minutes = Math.floor(safe%3600/60); const seconds = safe%60;
  return (hours ? `${String(hours).padStart(2,'0')}:` : '') + `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}
function toast(message,tone='success',undo) {
  const item=document.createElement('div'); item.className=`toast ${tone}`;
  const text=document.createElement('span'); text.textContent=message; item.append(text);
  if(undo){const button=document.createElement('button');button.textContent='Hoàn tác';button.onclick=()=>{undo();item.remove();};item.append(button);}
  $('#toastRegion').append(item);setTimeout(()=>item.remove(),undo?10000:5000);
}
async function api(url,options={}) {
  const response=await fetch(url,options);
  const data=await response.json().catch(()=>({error:'Máy chủ trả về dữ liệu không hợp lệ.'}));
  if(!response.ok)throw Object.assign(new Error(data.error||'Không thể hoàn tất yêu cầu.'),{status:response.status});
  return data;
}
const jsonRequest=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const backupDialog=new BackupDialog({dialog:$('#backupModal'),request:api,getProject:()=>state.project,getDemoSnapshot:reportSnapshot,
  savePending:async()=>{await state.saveChain;if(state.saveFailed)throw new Error('Lưu bản nháp trước khi sao lưu hoặc mở dự án khác.');},
  onRestored:async id=>{await refreshProjects();await openProject(id);},onExport:recordExport,toast,
  isRecording:()=>recordingDialog.recorder.active||recordingDialog.saving});
const subtitleDialog=new SubtitleDialog({dialog:$('#subtitleModal'),request:api,getProject:()=>state.project,
  savePending:async()=>{await state.saveChain;if(state.saveFailed)throw new Error('Lưu bản nháp trước khi nhập transcript.');},
  onImported:async id=>{await refreshProjects();await openProject(id);switchTab('transcript');},toast,
  isBusy:()=>recordingDialog.recorder.active||recordingDialog.saving||state.batch?.running||state.job?.status==='running'||projectIsBusy()});
const historyDialog=new HistoryDialog({dialog:$('#historyModal'),request:api,getProject:()=>state.project,
  savePending:async()=>{await state.saveChain;if(state.saveFailed)throw new Error('Lưu bản nháp trước khi dùng lịch sử phiên bản.');},
  onRestored:async id=>{const time=state.time;await refreshProjects();await openProject(id,false,time);switchTab('transcript');},toast,
  isBusy:()=>recordingDialog.recorder.active||recordingDialog.saving||state.batch?.running||state.job?.status==='running'||projectIsBusy()});
state.batch=new BatchQueue({request:api,onChange:()=>{renderBatch();renderJob();},onSettled:batchSettled,onError:error=>toast(error.message,'error')});
function fileSizeText(bytes){const value=Number(bytes)||0;if(value<1024*1024)return `${Math.max(1,Math.round(value/1024))} KB`;return `${(value/1024/1024).toFixed(value>10*1024*1024?0:1)} MB`;}
function saveBadge(text,status='saved') { const badge=$('.saved-badge');badge.innerHTML=`<span></span>${escapeHtml(text)}`;badge.dataset.status=status; }
function save(patch) {
  if(patch.transcript)renderInsights();
  const id=state.project.id; const copy=structuredClone(patch);state.saveCount++;saveBadge('Đang lưu…','saving');
  const task=state.saveChain.then(async()=>{
    if(id==='demo')localStorage.setItem('audiokit-demo',JSON.stringify({...readStorage('audiokit-demo',{}),...copy}));
    else await api(`/api/projects/${id}`,jsonRequest('PATCH',copy));
  }).then(()=>{
    const draft=readStorage(`audiokit-draft-${id}`,{});for(const key of Object.keys(copy))delete draft[key];
    if(Object.keys(draft).length)localStorage.setItem(`audiokit-draft-${id}`,JSON.stringify(draft));else localStorage.removeItem(`audiokit-draft-${id}`);
    state.saveFailed=Object.keys(draft).length>0;
  }).catch(error=>{
    state.saveFailed=true;try{localStorage.setItem(`audiokit-draft-${id}`,JSON.stringify({...readStorage(`audiokit-draft-${id}`,{}),...copy}));}catch{}
    toast(`Chưa lưu được: ${error.message} Nhấn “Chưa lưu” để thử lại.`,'error');
  }).finally(()=>{
    state.saveCount--;if(state.project.id===id)saveBadge(state.saveFailed?'Chưa lưu':state.saveCount?'Đang lưu…':'Đã lưu',state.saveFailed?'error':'saved');
  });
  state.saveChain=task;return task;
}
function speakerFor(id) {return state.project.speakers.find(item=>item.id===id)||{id,name:'Chưa gán',color:'#979baa'};}
function highlighted(text) {
  if(!state.query.trim())return escapeHtml(text);
  const pattern=state.query.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return text.split(new RegExp(`(${pattern})`,'ig')).map((part,index)=>index%2?`<mark>${escapeHtml(part)}</mark>`:escapeHtml(part)).join('');
}
function renderTranscript() {
  const project=state.project;
  const range=renderClipSelection();const selected=new Set(range?.lines.map(line=>line.id)||[]);
  $('.tab[data-tab="transcript"] .tab-count').textContent=project.transcript.length;
  const lines=project.transcript.filter(line=>(state.speaker==='all'||line.speaker===state.speaker)&&(!state.query.trim()||line.text.toLocaleLowerCase().includes(state.query.trim().toLocaleLowerCase())));
  if(!lines.length){$('#transcriptList').innerHTML=`<div class="empty-state"><div class="empty-icon">${icon('wave')}</div><strong>${project.transcript.length?'Không tìm thấy nội dung phù hợp':'Câu chuyện của bạn bắt đầu ở đây'}</strong><p>${project.transcript.length?'Thử một từ khoá hoặc người nói khác.':'Chạy Transcript để chuyển lời nói thành văn bản có mốc thời gian.'}</p>${project.transcript.length?'':'<button class="button primary" data-start-transcript>Tạo transcript</button>'}</div>`;return;}
  $('#transcriptList').innerHTML=lines.map(line=>{
    const person=speakerFor(line.speaker);
    const speaker=state.editing?`<select class="speaker-select" data-line-speaker="${escapeHtml(line.id)}" aria-label="Người nói tại ${formatTime(line.time)}">${project.speakers.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===line.speaker?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}</select>`:`<button class="speaker-tag" style="color:${person.color};background:${person.color}16" data-edit-speaker="${escapeHtml(person.id)}" title="Đổi tên người nói"><i class="tag-dot" style="background:${person.color}"></i>${escapeHtml(person.name)}</button>`;
    return `<article class="transcript-line${selected.has(line.id)?' clip-selected':''}" data-line-id="${escapeHtml(line.id)}" role="listitem"><span class="line-position">${state.clipSelecting?`<button class="clip-select-line" data-clip-line="${escapeHtml(line.id)}" aria-label="Chọn đoạn tại ${formatClipTime(line.time)}" aria-pressed="${selected.has(line.id)}">${selected.has(line.id)?'✓':'＋'}</button>`:''}<button class="line-time" data-seek="${line.time}" aria-label="Tua tới ${formatTime(line.time)}">${formatTime(line.time)}</button></span><div>${speaker}</div><p class="transcript-text" ${state.editing?'contenteditable="true" role="textbox" spellcheck="false"':''} data-edit-line="${escapeHtml(line.id)}">${highlighted(line.text)}</p><span class="confidence${line.confidence!==null&&line.confidence<85?' medium':''}" ${state.confidence?'':'hidden'} title="Xác suất từ do mô hình ước lượng, không phải độ chính xác đã kiểm chứng">${line.confidence===null?'<span class="manual-label" title="Không có điểm tin cậy từ mô hình">—</span>':`<i class="confidence-bar"><span style="width:${line.confidence}%"></span></i>${line.confidence}%`}</span>${state.clipSelecting&&line.id===state.clipEnd?`<button class="clip-inline-review" data-review-clip>Nghe & cắt ${range.lines.length} đoạn →</button>`:''}</article>`;
  }).join('');highlightCurrent();
}
function currentClipRange(){return selectedClipRange(state.project.transcript,state.clipAnchor,state.clipEnd,state.project.duration);}
function reviewClip(){const range=currentClipRange();if(range)clipEditor.open(range,state.usingClean);}
function renderClipSelection(){
  const range=currentClipRange(),selecting=state.clipSelecting;
  $('#clipSelectionBar').hidden=!selecting||state.activeTab!=='transcript';
  $('#selectClipButton').hidden=state.activeTab!=='transcript';
  $('#selectClipButton').disabled=!state.project.transcript.length||!!state.generating||state.job?.status==='running';
  $('#selectClipButton').classList.toggle('selecting',selecting);$('#selectClipButton').setAttribute('aria-pressed',String(selecting));
  $('#clipSelectionSummary').textContent=range?`${range.lines.length} đoạn · ${formatClipTime(range.start)} — ${formatClipTime(range.end)}`:'Chọn đoạn đầu và đoạn cuối';
  $('#clipReviewButton').disabled=!range;$('#clipResetSelection').disabled=!range;
  $('#editTranscriptButton').disabled=selecting||projectIsBusy();
  $('#searchTranscriptButton').disabled=selecting;
  $$('[data-speaker-filter]').forEach(button=>button.disabled=selecting);
  return range;
}
function cancelClipSelection(){state.clipSelecting=false;state.clipAnchor=null;state.clipEnd=null;renderTranscript();}
function startClipSelection(){
  if(state.clipSelecting)return cancelClipSelection();
  if(!state.project?.transcript.length||projectIsBusy()||state.job?.status==='running')return;
  state.clipSelecting=true;state.clipAnchor=null;state.clipEnd=null;state.editing=false;state.query='';state.speaker='all';
  $('#editTranscriptButton').innerHTML='Chỉnh sửa transcript <span>→</span>';$('#transcriptSearch').value='';$('#searchRow').hidden=true;
  renderSpeakers();renderTranscript();
  $('[data-clip-line]')?.focus({preventScroll:true});$('#clipSelectionBar').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function highlightCurrent() {
  const current=state.project?.transcript.find(line=>state.time>=line.time&&state.time<line.end);
  $$('.transcript-line').forEach(element=>element.classList.toggle('current',element.dataset.lineId===current?.id));
}
function renderSpeakers() {
  const project=state.project;
  $('#speakerFilters').innerHTML=`<button class="speaker-filter ${state.speaker==='all'?'active':''}" data-speaker-filter="all">Tất cả</button>`+project.speakers.map(person=>`<button class="speaker-filter ${state.speaker===person.id?'active':''}" data-speaker-filter="${escapeHtml(person.id)}"><i class="filter-dot" style="background:${person.color}"></i>${escapeHtml(person.name)}</button>`).join('');
  const totals={};for(const line of project.transcript)totals[line.speaker]=(totals[line.speaker]||0)+line.end-line.time;
  if(!project.transcript.length)for(const turn of project.turns||[])totals[turn.speaker]=(totals[turn.speaker]||0)+turn.end-turn.start;
  const sum=Object.values(totals).reduce((value,item)=>value+item,0)||1;
  $('#speakerList').innerHTML=project.speakers.length?project.speakers.map(person=>`<button class="speaker-row" data-edit-speaker="${escapeHtml(person.id)}" title="Đổi tên ${escapeHtml(person.name)}"><span class="speaker-avatar" style="background:${person.color}">${escapeHtml(person.name[0].toUpperCase())}</span><span class="speaker-info"><strong>${escapeHtml(person.name)}</strong><span>${formatTime(totals[person.id]||0)} lời nói</span></span><span class="speaker-percent">${Math.round((totals[person.id]||0)/sum*100)}%</span></button>`).join(''):'<p class="empty-small">Chạy tách người nói để nhận diện các lượt nói trong bản thu.</p>';
  $('.detected-badge').textContent=project.isDemo?'2 giọng mẫu':project.processed.speakers?`${project.speakers.length} người nói`:'Chưa phân tách';
}
function noteMarkup(note,full=false) {
  return full?`<article class="full-note"><button class="quick-note-time" data-note-seek="${note.time}">${formatTime(note.time)}</button><p contenteditable="true" role="textbox" aria-label="Sửa ghi chú" data-edit-note="${escapeHtml(note.id)}">${escapeHtml(note.text)}</p><button class="delete-note" data-delete-note="${escapeHtml(note.id)}" aria-label="Xoá ghi chú">×</button></article>`:`<button class="quick-note" data-note-seek="${note.time}"><span class="quick-note-time">${formatTime(note.time)}</span><span class="quick-note-body"><span class="quick-note-text">${escapeHtml(note.text)}</span><span>Ghi chú của bạn</span></span></button>`;
}
function renderNotes() {
  const notes=state.project.notes;$('#notesCount').textContent=notes.length;
  $('#quickNotesList').innerHTML=notes.slice(0,3).map(note=>noteMarkup(note)).join('')||'<p class="empty-small">Ý hay vừa xuất hiện? Lưu lại ở mốc đang nghe.</p>';
  $('#notesView').innerHTML=notes.map(note=>noteMarkup(note,true)).join('')||'<div class="notes-view-empty">Chưa có ghi chú. Viết ghi chú đầu tiên ở khung bên phải.</div>';
  $('#viewAllNotesButton').innerHTML=`Xem ${notes.length?`tất cả ${notes.length}`:'tất cả'} ghi chú <span>→</span>`;
  renderInsights();
}
function highlightIsSaved(point){return state.project.notes.some(note=>note.text===point.text&&Math.abs(note.time-point.time)<.001);}
function renderInsights(){
  const project=state.project;if(!project)return;
  const view=$('#insightsView'),insights=project.insights,current=insightsAreCurrent(project),busy=projectIsBusy();
  $('#summaryDot').hidden=!insights;$('#summaryDot').classList.toggle('stale',!!insights&&!current);$('#summaryDot').title=current?'Tóm tắt đã cập nhật':'Tóm tắt cần cập nhật';
  const createButton=`<button class="button primary summary-generate" data-generate-insights ${busy?'disabled':''}>${state.generating===project.id?'Đang tạo…':insights?'Cập nhật tóm tắt':'Tạo tóm tắt'}</button>`;
  if(!insights){
    const hasText=project.transcript.some(line=>/[\p{L}\p{N}]/u.test(line.text));
    view.innerHTML=`<div class="empty-state summary-empty"><div class="empty-icon">✦</div><strong>${hasText?'Nắm ý chính, bắt đúng khoảnh khắc':'Tóm tắt bắt đầu từ transcript'}</strong><p>${hasText?'Tạo bản tóm tắt, các chương nội dung và ý chính có mốc thời gian. Nội dung được trích ngay từ lời nói trong bản thu.':'Tạo transcript trước để ứng dụng chọn các ý quan trọng và chia chương cho bản thu.'}</p>${hasText?createButton:`<button class="button primary" data-start-transcript ${busy?'disabled':''}>Tạo transcript</button>`}<span class="summary-privacy">Xử lý trên máy · Giữ ngôn ngữ bản thu</span></div>`;return;
  }
  const passage=item=>`<li><button class="summary-time" data-seek="${item.time}" aria-label="Nghe từ ${formatTime(item.time)}">${formatTime(item.time)}</button><p>${escapeHtml(item.text)}</p></li>`;
  const remaining=insights.highlights.filter(point=>!highlightIsSaved(point)).length;
  view.innerHTML=`<div class="summary-heading"><div><span class="summary-eyebrow">✦ TỪ CUỘC TRÒ CHUYỆN</span><h2>Bản thu, cô đọng.</h2><p>${insights.chapters.length} chương · ${insights.highlights.length} ý chính · Trích từ transcript</p></div>${createButton}</div>
    ${current?'':`<div class="summary-stale" role="status"><strong>Transcript đã thay đổi.</strong> Cập nhật tóm tắt để các ý và mốc thời gian khớp với bản mới.</div>`}
    <section class="summary-overview" aria-label="Tóm tắt nội dung"><div class="summary-section-heading"><h3>Tóm tắt nội dung</h3><span>Giữ ngôn ngữ bản thu</span></div><ul>${insights.summary.map(passage).join('')}</ul></section>
    <section class="summary-section" aria-label="Chương nội dung"><div class="summary-section-heading"><h3>Chương nội dung</h3><span>Nhấn để nghe lại</span></div><div class="chapter-list">${insights.chapters.map((chapter,index)=>`<button class="chapter-row" data-seek="${chapter.start}" aria-label="Nghe chương ${index+1}: ${escapeHtml(chapter.title)}"><span class="chapter-number">${String(index+1).padStart(2,'0')}</span><span class="chapter-copy"><strong>${escapeHtml(chapter.title)}</strong><span>${formatTime(chapter.start)} — ${formatTime(chapter.end)}<i>·</i>${chapter.sourceIds.length} đoạn</span></span><span class="chapter-play" aria-hidden="true">▷</span></button>`).join('')}</div></section>
    <section class="summary-section" aria-label="Ý chính có mốc thời gian"><div class="summary-section-heading"><h3>Ý chính đáng lưu</h3><button class="summary-text-action" data-save-highlight="all" ${!current||!remaining?'disabled':''}>${remaining?'Lưu tất cả vào ghi chú':'Đã lưu tất cả'}</button></div><div class="highlight-list">${insights.highlights.map(point=>{const saved=highlightIsSaved(point);return `<article class="highlight-item"><div class="highlight-top"><button class="summary-time" data-seek="${point.time}" aria-label="Nghe ý chính từ ${formatTime(point.time)}">${formatTime(point.time)}</button><span>${escapeHtml(speakerFor(point.speaker).name)}</span></div><p>${escapeHtml(point.text)}</p><div class="highlight-actions"><button class="summary-text-action" data-insight-source="${escapeHtml(point.id)}" ${!current?'disabled':''}>Xem đoạn gốc ↗</button><button class="highlight-save ${saved?'saved':''}" data-save-highlight="${escapeHtml(point.id)}" ${!current||saved?'disabled':''}>${saved?'✓ Đã lưu':'＋ Lưu ghi chú'}</button></div></article>`;}).join('')}</div></section>
    <p class="summary-footnote">Tự động chọn câu nổi bật và ước lượng ranh giới chương từ transcript. Bạn có thể mở đoạn gốc để đối chiếu. Đã tạo ${escapeHtml(new Date(insights.generatedAt).toLocaleString('vi-VN'))}.</p>`;
}
async function generateInsights(){
  if(!state.project||state.generating||projectIsBusy())return;
  const id=state.project.id;state.generating=id;state.editing=false;
  $('#editTranscriptButton').innerHTML='Chỉnh sửa transcript <span>→</span>';renderTranscript();renderInsights();renderJob();
  try{
    await state.saveChain;if(state.saveFailed)throw new Error('Hãy lưu bản nháp trước. Nhấn “Chưa lưu” để thử lại.');
    if(state.project.id!==id)return;
    const fingerprint=transcriptFingerprint(state.project.transcript);
    const insights=id==='demo'?buildInsights(state.project):(await api(`/api/projects/${id}/insights`,jsonRequest('POST',{sourceFingerprint:fingerprint}))).insights;
    if(state.project.id!==id)return;
    state.project.insights=insights;
    if(id==='demo')await save({insights});
    renderInsights();toast('Đã tạo tóm tắt, chương nội dung và ý chính.');
  }catch(error){toast(error.message,'error');}
  finally{state.generating=null;if(state.project){renderInsights();renderJob();}}
}
function saveHighlights(id){
  if(!insightsAreCurrent(state.project)){toast('Cập nhật tóm tắt trước khi lưu ý chính.','info');return;}
  const points=state.project.insights.highlights.filter(point=>(id==='all'||point.id===id)&&!highlightIsSaved(point));
  if(!points.length)return;
  if(state.project.notes.length+points.length>3000){toast('Dự án đã đạt giới hạn 3.000 ghi chú.','error');return;}
  state.project.notes.unshift(...points.map(point=>({id:crypto.randomUUID(),time:point.time,text:point.text})));
  renderNotes();save({notes:state.project.notes});toast(`Đã thêm ${points.length} ý chính vào ghi chú.`);
}
function showInsightSource(id){
  if(!insightsAreCurrent(state.project))return;
  const point=state.project.insights.highlights.find(item=>item.id===id);if(!point)return;
  state.query='';state.speaker='all';$('#transcriptSearch').value='';renderSpeakers();renderTranscript();switchTab('transcript');renderJob();seek(point.time);
  const line=$(`[data-line-id="${CSS.escape(point.sourceIds[0])}"]`);if(!line)return;
  line.classList.add('source-highlight');line.scrollIntoView({behavior:'smooth',block:'center'});$('.line-time',line).focus({preventScroll:true});setTimeout(()=>line.classList.remove('source-highlight'),5000);
}
function switchTab(tab) {
  state.activeTab=tab;
  if(tab!=='transcript'&&state.clipSelecting)cancelClipSelection();
  $$('.tab').forEach(element=>{const active=element.dataset.tab===tab;element.classList.toggle('active',active);element.setAttribute('aria-selected',String(active));});
  $('#transcriptList').hidden=tab!=='transcript';$('#transcriptToolbar').hidden=tab!=='transcript';$('#notesView').hidden=tab!=='notes';$('#insightsView').hidden=tab!=='summary';$('#transcriptFooter').hidden=tab!=='transcript';
  $('#searchTranscriptButton').hidden=tab!=='transcript';$('#searchRow').hidden=tab!=='transcript'||!state.query;if(tab==='summary')renderInsights();
  renderClipSelection();
}
function processingJob(){return state.batch?.items.find(item=>['importing','processing','cancelling'].includes(item.status))?.job||state.job;}
function projectIsBusy(){const job=processingJob();return state.generating===state.project?.id||job?.status==='running'&&job.projectId===state.project?.id;}
function renderJob() {
  const project=state.project;if(!project)return;
  const job=processingJob(),running=job?.status==='running'||!!state.generating||state.batch?.running;const own=projectIsBusy();
  const steps=[['noise','#noiseButton','Lọc tiếng ồn'],['transcript','#transcriptButton','Transcript'],['speakers','#speakerButton','Tách người nói']];
  for(const [key,selector,label]of steps){const element=$(selector);element.disabled=!!running;element.classList.toggle('done',project.processed[key]);element.classList.toggle('processing',!!own&&job?.status==='running'&&(job.stage===key||job.kind===key));element.innerHTML=`<span class="pill-check">${project.processed[key]?'✓':'○'}</span><span>${label}</span>`;}
  const completed=Object.values(project.processed).filter(Boolean).length;
  $('#processingSummary').textContent=state.generating===project.id?'Đang tạo tóm tắt…':own?job.message:project.isDemo?'Bản mẫu đã sẵn sàng':`${completed}/3 bước đã hoàn tất`;
  $('#processAllButton').disabled=!!running;$('#processAllButton').innerHTML=own?'Đang xử lý…':project.isDemo?'Thử AI <span>↗</span>':completed===3?'Chạy lại <span>↗</span>':'Xử lý tất cả <span>↗</span>';
  $('#processingProgress').hidden=!own||state.generating===project.id;$('#cancelJobButton').hidden=!own||state.generating===project.id;
  const progress=job?.progress;$('#processingProgress').classList.toggle('indeterminate',progress==null);
  $('#processingProgress span').style.width=progress==null?'35%':`${Math.max(2,progress*100)}%`;
  $('#editTranscriptButton').disabled=!!own||state.clipSelecting;
  $('#importTranscriptButton').disabled=!!running;
  $('#addSpeakerButton').disabled=!!own;
  $$('[data-edit-speaker]').forEach(button=>button.disabled=!!own);
  if(own&&state.editing){state.editing=false;$('#editTranscriptButton').innerHTML='Chỉnh sửa transcript <span>→</span>';renderTranscript();$$('[data-edit-speaker]').forEach(button=>button.disabled=true);}
  $('#jobIndicator').hidden=!running;
  $$('[data-generate-insights]').forEach(button=>button.disabled=!!own);
  $$('[data-start-transcript]').forEach(button=>button.disabled=!!running);
  renderClipSelection();
}
function renderProject() {
  const project=state.project;$('#fileName').textContent=project.name;
  $('#fileMeta').textContent=`${project.fileName}  ·  ${project.sampleRate/1000} kHz ${project.format}  ·  ${formatTime(project.duration)}`;
  $('#sourceLabel').textContent=project.isDemo?'BẢN THU MẪU':'BẢN THU CỦA BẠN';
  $('#demoNotice').hidden=!project.isDemo;
  $('#audioVariant').disabled=!project.processed.noise;$('#audioVariant').textContent=state.usingClean?'Đã lọc ồn':'Bản gốc';$('#audioVariant').classList.toggle('is-clean',state.usingClean);
  const languages={en:'Tiếng Anh',vi:'Tiếng Việt',ja:'Tiếng Nhật',ko:'Tiếng Hàn',zh:'Tiếng Trung',fr:'Tiếng Pháp',de:'Tiếng Đức',es:'Tiếng Tây Ban Nha'};
  $('.transcript-language').innerHTML=`<span class="language-flag">${escapeHtml((project.language||'--').toUpperCase())}</span><span>${languages[project.language]||'Chưa nhận diện'}</span>`;
  $('#transcriptFooter > span').innerHTML=`<span class="status-dot"></span>${project.isDemo?'Mẫu có giọng tổng hợp · transcript biên soạn':project.processed.transcript?project.transcriptEdited?'Transcript đã biên tập · cần rà soát trước khi dùng':'Whisper cục bộ · cần rà soát trước khi dùng':'Transcript sẽ được tạo trên máy này'}`;
  $('#qualityValue').textContent=Number.isFinite(project.metrics?.peakDb)?project.metrics.peakDb.toFixed(1):'—';
  $('#qualityDetail').textContent=Number.isFinite(project.metrics?.rmsDb)?`Mức trung bình ${project.metrics.rmsDb.toFixed(1)} dBFS`:'Chưa phân tích âm thanh';
  $('.quality-meter span').style.width=`${Math.max(2,Math.min(100,(60+(project.metrics?.peakDb||-60))/60*100))}%`;
  $('#noiseStatus').textContent=project.processed.noise?'Có bản lọc ồn để so sánh':'Chưa có bản lọc ồn';
  renderSpeakers();renderTranscript();renderNotes();switchTab(state.activeTab);renderJob();updateTime();
}
function drawWaveform() {
  const canvas=$('#waveform'),shell=$('#waveformShell'),rectangle=shell.getBoundingClientRect();
  const width=Math.round(rectangle.width),height=Math.round(rectangle.height);if(!width||!height)return;
  const ratio=devicePixelRatio||1;canvas.width=width*ratio;canvas.height=height*ratio;
  const context=canvas.getContext('2d');context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
  const peaks=state.project?.metrics?.peaks||[];const count=Math.min(peaks.length,Math.floor((width-32)/4));
  if(!count)return;const progress=state.time/(state.project.duration||1);const maximum=Math.max(...peaks,.02);
  for(let index=0;index<count;index++){
    const start=Math.floor(index/count*peaks.length),end=Math.max(start+1,Math.floor((index+1)/count*peaks.length));
    const peak=Math.max(...peaks.slice(start,end));const barHeight=Math.max(2,Math.pow(peak/maximum,.7)*(height-45));
    const x=16+index*(width-32)/count;context.fillStyle=index/count<=progress?'#a29fff':'#696887';
    context.beginPath();context.roundRect(x,(height-barHeight)/2-3,2.2,barHeight,2);context.fill();
  }
}
function updateTime() {
  if(!state.project)return;
  const current=formatTime(state.time),end=formatTime(state.project.duration);
  $('#currentTime').textContent=current;$('#transportCurrent').textContent=current;$('#noteTimeChip').textContent=current;
  $('#endTime').textContent=end;$('#transportDuration').textContent=end;
  $('#waveformMarker').style.left=`${Math.min(99.8,Math.max(0,state.time/state.project.duration*100))}%`;
  $('#waveformShell').setAttribute('aria-valuenow',String(Math.round(state.time)));$('#waveformShell').setAttribute('aria-valuemax',String(Math.round(state.project.duration)));
  drawWaveform();highlightCurrent();
}
function seek(time){if(!state.project)return;state.time=Math.max(0,Math.min(state.project.duration,Number(time)||0));if(audio.readyState)audio.currentTime=state.time;updateTime();}
function play(){if(!audio.src)return;if(audio.paused)audio.play().catch(error=>toast(`Không phát được âm thanh: ${error.message}`,'error'));else audio.pause();}
function setAudio(keepTime=false,startAt=0) {
  const wasPlaying=!audio.paused;const time=keepTime?state.time:Math.max(0,Math.min(state.project.duration,Number(startAt)||0));audio.pause();
  audio.src=state.usingClean?state.project.cleanUrl:state.project.audioUrl;
  audio.addEventListener('loadedmetadata',()=>{audio.currentTime=Math.min(time,audio.duration);if(wasPlaying&&keepTime)audio.play().catch(()=>{});},{once:true});
  if(!keepTime){state.time=time;updateTime();}
}
async function refreshProjects(){state.projects=await api('/api/projects');$('.nav-item[data-nav="projects"] b').textContent=state.projects.length;}
async function openProject(id,initial=false,startAt=0) {
  if(!initial)await state.saveChain;
  audio.pause();const project=await api(`/api/projects/${id}`);
  if(id==='demo')Object.assign(project,readStorage('audiokit-demo',{}));
  const draft=readStorage(`audiokit-draft-${id}`,{});Object.assign(project,draft);
  state.project=project;state.time=0;state.speaker='all';state.query='';state.editing=false;state.usingClean=false;
  state.clipSelecting=false;state.clipAnchor=null;state.clipEnd=null;if($('#clipModal').open)$('#clipModal').close();
  $('#transcriptSearch').value='';$('#searchRow').hidden=true;$('#editTranscriptButton').innerHTML='Chỉnh sửa transcript <span>→</span>';
  state.saveFailed=Object.keys(draft).length>0;
  renderProject();setAudio(false,startAt);$$('[data-project-surface]').forEach(element=>element.inert=false);saveBadge('Đã lưu');if(state.saveFailed)save(draft);
  try{localStorage.setItem('audiokit-last',id);}catch{}
}
async function importFile(file) {
  if(!file)return;
  if(recordingDialog.recorder.active||recordingDialog.saving){toast('Hoàn tất thu âm và lưu bản thu trước khi nhập file khác.','info');return;}
  const fileError=audioFileError(file);if(fileError){toast(fileError,'error');return;}
  const button=$('#importButton');button.disabled=true;button.innerHTML='Đang đọc bản thu…';$('#uploadStatus').hidden=false;
  try{await state.saveChain;const form=new FormData();form.append('audio',file);const project=await api('/api/projects',{method:'POST',body:form});await openProject(project.id);await refreshProjects();toast('Đã nhập bản thu. Chọn xử lý tất cả để bắt đầu.');}
  catch(error){toast(error.message,'error');}
  finally{button.disabled=false;button.innerHTML='<span class="button-symbol">＋</span> Nhập file mới';$('#uploadStatus').hidden=true;$('#fileInput').value='';}
}
function importFiles(files){
  if(!files?.length)return;
  if(files.length>1||state.batch.running||$('#batchModal').open)openBatch(files);else void importFile(files[0]);
}
function batchStatusText(item){
  if(item.status==='awaiting-upload')return 'Chờ tải file';
  if(item.status==='queued')return 'Đang chờ';
  if(item.status==='uploading')return 'Đang tải file…';
  if(item.status==='importing')return 'Đang nhập…';
  if(item.status==='processing')return item.stage==='noise'?'Đang lọc ồn…':item.stage==='transcript'?'Đang tạo transcript…':item.stage==='speakers'?'Đang tách người nói…':'Đang xử lý…';
  if(item.status==='completed')return 'Hoàn tất';
  if(item.status==='cancelled')return 'Đã huỷ';
  if(item.status==='cancelling')return 'Đang huỷ…';
  return 'Có lỗi';
}
function renderBatch(){
  const batch=state.batch;if(!batch)return;
  const focused=document.activeElement?.closest('#batchList [data-batch-select],#batchList [data-batch-open],#batchList [data-batch-cancel],#batchList [data-batch-retry],#batchList [data-batch-remove]');
  const focusAttribute=focused&&[...focused.attributes].find(attribute=>attribute.name.startsWith('data-batch-'));
  const items=batch.items,completed=items.filter(item=>item.status==='completed'&&item.project),active=items.filter(item=>['uploading','importing','processing','cancelling'].includes(item.status)),failed=items.filter(item=>item.status==='failed');
  $('#batchSummary').textContent=items.length?`${items.length}/${MAX_BATCH_FILES} file · ${completed.length} hoàn tất${active.length?` · ${active.length} đang chạy`:''}${failed.length?` · ${failed.length} lỗi`:''}`:'Chọn hoặc kéo thả nhiều file âm thanh.';
  $('#batchQueueCount').textContent=String(items.length);$('#batchQueueButton').hidden=!items.length;
  const persistence=$('#batchPersistenceStatus'),missing=items.some(item=>item.needsUpload&&!['cancelled','failed'].includes(item.status));
  persistence.textContent=batch.connectionError||batch.serverError||(!batch.ready?'Đang kết nối hàng đợi đã lưu…':batch.hasUnuploaded?'Đang tải file lên máy. Giữ tab mở đến khi tải xong.':missing?'Có file tải chưa xong. Chọn lại đúng file để tiếp tục.':items.length?'Đã lưu trên máy · Có thể đóng tab. Xử lý tiếp khi máy chủ đang chạy.':'File được lưu trên máy trước khi bắt đầu xử lý.');
  persistence.classList.toggle('error',!!batch.connectionError||!!batch.serverError);
  $('#batchRecoverButton').hidden=!batch.serverError;
  const rowKey=items.map(item=>`${item.id}:${item.status}:${item.needsUpload&&!item.file}`).join('|');
  if(batch.renderKey!==rowKey){
  $('#batchList').innerHTML=items.length?items.map(item=>{
    const ready=item.status==='completed'&&item.project,progress=item.progress==null?'':`${Math.round(Math.max(0,Math.min(1,item.progress))*100)}%`;
    const remove=`<button class="batch-action danger" data-batch-remove="${escapeHtml(item.id)}" aria-label="Bỏ ${escapeHtml(item.name)} khỏi hàng đợi">Bỏ</button>`;
    const retry=item.needsUpload&&!item.file?`<button class="batch-action" data-batch-reselect="${escapeHtml(item.id)}">Chọn lại file</button>`:`<button class="batch-action" data-batch-retry="${escapeHtml(item.id)}" ${item.file&&audioFileError(item.file)?'disabled':''}>Thử lại</button>`;
    const action=item.status==='completed'?`<button class="batch-action" data-batch-open="${escapeHtml(item.project.id)}">Mở</button>`:['uploading','importing','processing','cancelling'].includes(item.status)?`<button class="batch-action danger" data-batch-cancel="${escapeHtml(item.id)}" ${item.status==='cancelling'?'disabled':''}>Huỷ</button>`:['awaiting-upload','failed','cancelled'].includes(item.status)?`${retry}${remove}`:remove;
    return `<div class="batch-row" data-batch-id="${escapeHtml(item.id)}" data-status="${escapeHtml(item.status)}"><input type="checkbox" data-batch-select="${escapeHtml(item.id)}" ${ready&&item.selected!==false?'checked':''} ${ready?'':'disabled'} aria-label="Chọn ${escapeHtml(item.name)} để xuất" /><div class="batch-file"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><small title="${escapeHtml(item.error||item.message||'')}">${fileSizeText(item.size)}${item.error||item.message?` · ${escapeHtml(item.error||item.message)}`:''}</small><div class="batch-progress" hidden><span style="width:${progress}"></span></div></div><div class="batch-actions"><span class="batch-status ${item.status==='completed'?'success':item.status==='failed'?'error':item.status==='cancelled'?'info':''}">${escapeHtml(batchStatusText(item))}${progress&&item.status==='processing'?` ${progress}`:''}</span>${action}</div></div>`;
  }).join(''):'<div class="batch-empty">Chọn nhiều file âm thanh để bắt đầu.</div>';
  if(focusAttribute)$(`[${focusAttribute.name}="${CSS.escape(focusAttribute.value)}"]`)?.focus({preventScroll:true});
  batch.renderKey=rowKey;
  }
  // Keep controls mounted while only a progress message changes, preserving focus
  // and clicks that begin between polling responses.
  for(const item of items){
    const row=$(`[data-batch-id="${CSS.escape(item.id)}"]`);if(!row)continue;
    const message=item.error||item.message||'',small=$('.batch-file small',row),progress=item.progress==null?'':`${Math.round(Math.max(0,Math.min(1,item.progress))*100)}%`;
    small.textContent=`${fileSizeText(item.size)}${message?` · ${message}`:''}`;small.title=message;
    $('.batch-status',row).textContent=batchStatusText(item)+(progress&&item.status==='processing'?` ${progress}`:'');
    const bar=$('.batch-progress',row);bar.hidden=!['uploading','importing','processing'].includes(item.status);bar.classList.toggle('indeterminate',item.progress==null);$('span',bar).style.width=progress;
    $('input',row).checked=item.status==='completed'&&item.selected!==false;
  }
  const hasQueued=items.some(item=>item.status==='queued'),hasSelected=completed.some(item=>item.selected!==false);
  $('#batchStartButton').disabled=!batch.ready||batch.starting||batch.running||batch.hasUnuploaded||missing||!hasQueued||!!batch.connectionError||!!batch.serverError;$('#batchStartButton').textContent=batch.running?'Đang xử lý…':batch.uploading?'Đang tải file…':missing?'Chờ tải đủ file':hasQueued?'Bắt đầu xử lý':'Không có file chờ';
  $('#batchExportButton').disabled=batch.exporting||!hasSelected;$('#batchExportButton').textContent=batch.exporting?'Đang tạo ZIP…':'Xuất ZIP';
  $('#batchClearButton').textContent=batch.running?'Huỷ & xoá':'Xoá hàng đợi';$('#batchClearButton').disabled=!items.length||batch.exporting||batch.clearRequested;
  $('#batchAddButton').disabled=items.length>=MAX_BATCH_FILES||batch.clearRequested;
  const options=batch.running&&batch.options?batch.options:state.options;
  $('#batchOptionsSummary').textContent=`Lọc ồn · Transcript ${options.model} · ${options.language==='auto'?'Tự nhận diện ngôn ngữ':options.language.toUpperCase()} · ${options.numSpeakers||'Tự ước lượng'} người nói`;
  $('#batchSettingsButton').disabled=batch.running;
}
function openBatch(files){
  if(recordingDialog.recorder.active||recordingDialog.saving){toast('Hoàn tất thu âm và lưu bản thu trước khi nhập file khác.','info');return;}
  if(files?.length)void state.batch.add(files).then(additions=>{if(files.length>additions)toast(`Mỗi hàng đợi nhận tối đa ${MAX_BATCH_FILES} file. Xoá các mục cũ để thêm tiếp.`,'info');}).catch(error=>toast(error.message,'error'));
  $('#batchExportStatus').textContent='';renderBatch();if(!$('#batchModal').open)$('#batchModal').showModal();
}
function selectedBatchFiles(){return state.batch?.items.filter(item=>item.status==='completed'&&item.project&&item.selected!==false)||[];}
async function startBatch(){
  const batch=state.batch;if(!batch||batch.running)return;
  if(state.job?.status==='running'||state.generating){toast('Đợi tác vụ hiện tại hoàn tất trước khi bắt đầu hàng loạt.','info');return;}
  try{await state.saveChain;if(state.saveFailed)throw new Error('Hãy lưu bản nháp trước khi chạy AI.');}
  catch(error){toast(error.message,'error');return;}
  try{await batch.start(state.options);toast('Hàng đợi đã lưu trên máy chủ. Bạn có thể đóng tab.');}catch(error){toast(error.message,'error');}
}
async function batchSettled(batch){
  renderJob();
  const completed=batch.items.filter(item=>item.status==='completed').length;
  if(batch.items.length)toast(`Hàng đợi đã kết thúc · ${completed}/${batch.items.length} file hoàn tất.`,completed?'success':'info');
  await refreshProjects();
  const updated=batch.items.find(item=>item.project?.id===state.project?.id&&item.project);
  if(updated){await state.saveChain;const time=state.time;await openProject(updated.project.id,false,time);}
}
function retryBatchItem(id){
  void state.batch.retry(id).catch(error=>toast(error.message,'error'));
}
function clearBatch(){
  void state.batch.clear().catch(error=>toast(error.message,'error'));$('#batchExportStatus').textContent='';
}
function batchDownloadFilename(response){
  const header=response.headers.get('Content-Disposition')||'';return header.match(/filename="?([^";]+)"?/i)?.[1]||`audio-toolkit-${Date.now()}.zip`;
}
async function exportBatch(){
  const items=selectedBatchFiles(),formats=$$('[data-batch-format]:checked').map(input=>input.value);if(!items.length){toast('Chọn ít nhất một bản thu đã hoàn tất.','info');return;}if(!formats.length){toast('Chọn ít nhất một định dạng xuất.','info');return;}
  state.batch.exporting=true;const status=$('#batchExportStatus');status.classList.remove('error');status.textContent=`Đang tạo ZIP cho ${items.length} bản thu…`;renderBatch();
  try{await state.saveChain;const snapshots=await Promise.all(items.map(async item=>({project:reportSnapshot(item.project.id===state.project?.id?state.project:await api(`/api/projects/${item.project.id}`)),formats})));const response=await fetch('/api/batch/export',{...jsonRequest('POST',{layout:$('#batchReportLayout').value,items:snapshots})});if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Không thể tạo file ZIP.');}const blob=await response.blob(),filename=batchDownloadFilename(response),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),2000);recordExport(filename,'Nhiều bản thu');status.textContent=`Đã tạo ${filename}.`;toast(`Đã xuất ${filename}.`);}
  catch(error){status.textContent=error.message;status.classList.add('error');}
  finally{state.batch.exporting=false;renderBatch();}
}
async function startJob(kind) {
  if(!state.project)return;
  try{
    if(state.job?.status==='running'||state.generating||state.batch.running)throw new Error('Đợi tác vụ hiện tại hoàn tất trước.');
    await state.saveChain;
    if(state.saveFailed)throw new Error('Hãy lưu bản nháp trước khi chạy AI. Nhấn “Chưa lưu” để thử lại.');
    if(state.project.id==='demo'){const copy=await api('/api/demo/copy',{method:'POST'});await openProject(copy.id);await refreshProjects();toast('Đã tạo bản sao mẫu để chạy mô hình thật.','info');}
    if(state.clipSelecting)cancelClipSelection();
    state.editing=false;$('#editTranscriptButton').innerHTML='Chỉnh sửa transcript <span>→</span>';renderTranscript();
    state.job=await api(`/api/projects/${state.project.id}/jobs`,jsonRequest('POST',{kind,...state.options}));
    renderJob();pollJob();
  }catch(error){toast(error.message,'error');}
}
async function pollJob() {
  clearTimeout(state.polling);if(!state.job)return;
  try{
    state.job=await api(`/api/jobs/${state.job.id}`);renderJob();
    if(state.job.status==='running'){state.polling=setTimeout(pollJob,1400);return;}
    const id=state.job.projectId;
    if(state.project.id===id){await state.saveChain;const updated=await api(`/api/projects/${id}`);Object.assign(updated,readStorage(`audiokit-draft-${id}`,{}));state.project=updated;renderProject();}
    toast(state.job.message,state.job.status==='completed'?'success':state.job.status==='cancelled'?'info':'error');await refreshProjects();
  }catch(error){
    if(error.status===404){state.job=null;renderJob();toast('Máy chủ đã khởi động lại. Tác vụ cũ đã dừng; mở lại bản thu để xem các bước đã hoàn tất.','info');return;}
    toast(`Mất kết nối tác vụ: ${error.message}`,'error');state.polling=setTimeout(pollJob,4000);
  }
}
function addNote() {
  const text=$('#noteInput').value.trim();if(!text){$('#noteInput').focus();return;}
  state.project.notes.unshift({id:crypto.randomUUID(),time:Number(state.time.toFixed(3)),text:(state.notePrefix?`${state.notePrefix}: ${text}`:text).slice(0,2000)});
  $('#noteInput').value='';renderNotes();save({notes:state.project.notes});toast(`Đã ghi chú tại ${formatTime(state.time)}.`);
}
function openSpeaker(id=null) {
  if(!state.project||projectIsBusy()){toast('Đợi tác vụ hoàn tất trước khi sửa người nói.','info');return;}
  state.speakerEdit=id;const person=id?speakerFor(id):null;
  $('#speakerNameInput').value=person?.name||'';$('#speakerModal h2').textContent=id?'Đổi tên người nói':'Thêm người nói';$('#saveSpeakerButton').textContent=id?'Lưu tên':'Thêm người nói';$('#speakerModal').showModal();
}
function saveSpeaker(){
  if(projectIsBusy())return;
  const name=$('#speakerNameInput').value.trim();if(!name)return $('#speakerNameInput').focus();
  if(state.speakerEdit){const person=state.project.speakers.find(item=>item.id===state.speakerEdit);if(person)person.name=name;}
  else state.project.speakers.push({id:`s-${crypto.randomUUID()}`,name,color:colors[state.project.speakers.length%colors.length]});
  save({speakers:state.project.speakers});renderSpeakers();renderTranscript();$('#speakerModal').close();
}
function downloadContent(content,filename,mime) {
  const url=URL.createObjectURL(new Blob([content],{type:mime}));const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  recordExport(filename);toast(`Đã xuất ${filename}.`);
}
function recordExport(filename,project=state.project.name){
  state.exports.unshift({name:filename,time:new Date().toISOString(),project});state.exports=state.exports.slice(0,20);
  try{localStorage.setItem('audiokit-exports',JSON.stringify(state.exports));}catch{}
}
function exportProject(type){
  try{const file=createExport(state.project,type);downloadContent(file.content,file.filename,file.mime);$('#exportModal').close();}
  catch(error){toast(error.message,'error');}
}
function openExport(){
  const project=state.project;if(!project)return;
  const status=reportStatus(project),label=$('#reportContentState');label.dataset.status=status;
  label.textContent=status==='stale'?'Tóm tắt chưa cập nhật. Báo cáo sẽ ghi rõ chương và ý chính có thể chưa khớp với transcript hiện tại.':
    status==='missing'?'Chưa tạo tóm tắt. Báo cáo vẫn chứa transcript và ghi chú hiện có.':'Tóm tắt đã cập nhật · Báo cáo gồm toàn bộ nội dung hiện có.';
  $('#reportExportStatus').textContent='';$('#reportExportStatus').classList.remove('error');
  $('#exportModal').showModal();
}
function reportResponseFilename(response,project,type){
  const header=response.headers.get('Content-Disposition')||'';
  const encoded=header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if(encoded){try{return decodeURIComponent(encoded);}catch{}}
  const plain=header.match(/filename="?([^";]+)"?/i)?.[1];
  return plain||reportFilename(project.name,type);
}
async function exportReport(type){
  if(!state.project||state.reportExporting)return;
  const task={controller:new AbortController(),project:reportSnapshot(state.project)};state.reportExporting=task;
  const status=$('#reportExportStatus');status.classList.remove('error');status.textContent=`Đang tạo báo cáo ${type.toUpperCase()}…`;
  $$('[data-report],[data-export],#reportLayout').forEach(button=>button.disabled=true);$('#exportModal').setAttribute('aria-busy','true');
  try{
    const response=await fetch(`/api/projects/${encodeURIComponent(task.project.id)}/reports`,{...jsonRequest('POST',{format:type,layout:$('#reportLayout').value,project:task.project}),signal:task.controller.signal});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Không thể tạo báo cáo.');}
    const blob=await response.blob(),filename=reportResponseFilename(response,task.project,type);
    if(task.controller.signal.aborted)return;
    const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
    recordExport(filename,task.project.name);state.reportExporting=null;$('#exportModal').close();toast(`Đã xuất ${filename}.`);
  }catch(error){if(error.name!=='AbortError'){status.textContent=error instanceof TypeError?'Không kết nối được máy chủ. Kiểm tra Audio Toolkit đang chạy rồi thử lại.':error.message;status.classList.add('error');}}
  finally{if(state.reportExporting===task)state.reportExporting=null;$$('[data-report],[data-export],#reportLayout').forEach(button=>button.disabled=false);$('#exportModal').removeAttribute('aria-busy');}
}
async function openLibrary(mode='projects'){
  try{await refreshProjects();$('#libraryTitle').textContent=mode==='exports'?'Lịch sử xuất':'Thư viện bản thu';
    $('#projectLibrary').innerHTML=mode==='exports'?(state.exports.length?state.exports.map(item=>`<div class="library-row"><span class="file-type-icon">${icon('download')}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.project)} · ${new Date(item.time).toLocaleString('vi-VN')}</small></span></div>`).join(''):'<p class="empty-small">Chưa xuất file nào. Các file đã tải sẽ nằm trong thư mục Downloads của trình duyệt.</p>'):
      `<button class="library-row" data-open-project="demo"><span class="file-type-icon">${icon('wave')}</span><span><strong>Thói quen sáng tạo</strong><small>Mẫu có sẵn · 2 giọng tổng hợp</small></span><b>MỞ MẪU</b></button>`+state.projects.map(project=>`<button class="library-row" data-open-project="${project.id}"><span class="file-type-icon">${icon('wave')}</span><span><strong>${escapeHtml(project.name)}</strong><small>${formatTime(project.duration)} · ${project.transcriptCount} đoạn · ${project.noteCount} ghi chú</small></span><b>→</b></button>`).join('');
    $('#libraryModal').showModal();
  }catch(error){toast(error.message,'error');}
}
function bindEvents(){
  $('.saved-badge').onclick=()=>{const draft=readStorage(`audiokit-draft-${state.project.id}`,{});if(Object.keys(draft).length)save(draft);};
  $('#importButton').onclick=()=>$('#fileInput').click();$('#fileInput').onchange=event=>{importFiles([...event.target.files]);event.target.value='';};
  $('#batchQueueButton').onclick=()=>openBatch();$('#batchAddButton').onclick=()=>$('#batchFileInput').click();
  $('#batchFileInput').onchange=event=>{openBatch([...event.target.files]);event.target.value='';};
  $('#batchResumeFileInput').onchange=event=>{const file=event.target.files[0],id=event.target.dataset.itemId;event.target.value='';if(file&&id)void state.batch.replaceFile(id,file).catch(error=>toast(error.message,'error'));};
  $('#batchRecoverButton').onclick=()=>void state.batch.retryStorage().catch(error=>toast(error.message,'error'));
  $('#openBackupFromExport').onclick=()=>{$('#exportModal').close();backupDialog.open();};
  $('#openSubtitleImport').onclick=()=>{$('#exportModal').close();subtitleDialog.open();};
  $('#historyButton').onclick=()=>historyDialog.open();
  $('#openHistoryFromExport').onclick=()=>{$('#exportModal').close();historyDialog.open();};
  $('#importTranscriptButton').onclick=()=>subtitleDialog.open();
  $('#batchStartButton').onclick=()=>void startBatch();$('#batchClearButton').onclick=clearBatch;$('#batchExportButton').onclick=()=>void exportBatch();
  $('#batchSettingsButton').onclick=openSettings;
  $('#batchList').addEventListener('change',event=>{const select=event.target.closest('[data-batch-select]');if(select){const item=state.batch.items.find(entry=>entry.id===select.dataset.batchSelect);if(item)item.selected=select.checked;renderBatch();}});
  $('#batchList').addEventListener('click',async event=>{
    const target=event.target;
    const cancel=target.closest('[data-batch-cancel]');if(cancel)void state.batch.cancel(cancel.dataset.batchCancel).catch(error=>toast(error.message,'error'));
    const retry=target.closest('[data-batch-retry]');if(retry)retryBatchItem(retry.dataset.batchRetry);
    const remove=target.closest('[data-batch-remove]');if(remove)void state.batch.remove(remove.dataset.batchRemove).catch(error=>toast(error.message,'error'));
    const reselect=target.closest('[data-batch-reselect]');if(reselect){$('#batchResumeFileInput').dataset.itemId=reselect.dataset.batchReselect;$('#batchResumeFileInput').click();}
    const open=target.closest('[data-batch-open]');if(open){try{await openProject(open.dataset.batchOpen);$('#batchModal').close();}catch(error){toast(error.message,'error');}}
  });
  $('#recordButton').onclick=()=>recordingDialog.open();
  $('#playButton').onclick=play;$('#backButton').onclick=()=>seek(state.time-15);$('#forwardButton').onclick=()=>seek(state.time+15);
  audio.volume=.8;$('#volumeRange').oninput=event=>{audio.volume=Number(event.target.value);audio.muted=false;};
  $('#volumeButton').onclick=()=>{audio.muted=!audio.muted;$('#volumeButton').innerHTML=icon(audio.muted?'muted':'volume');};
  const speeds=[.75,1,1.25,1.5,2];$('#speedButton').onclick=()=>{audio.playbackRate=speeds[(speeds.indexOf(audio.playbackRate)+1)%speeds.length];$('#speedButton').textContent=`${audio.playbackRate}×`;};
  audio.ontimeupdate=()=>{state.time=audio.currentTime;updateTime();};audio.onplay=()=>{$('#playIcon').innerHTML=icon('pause');$('#playButton').setAttribute('aria-label','Tạm dừng');};audio.onpause=()=>{$('#playIcon').innerHTML=icon('play');$('#playButton').setAttribute('aria-label','Phát');};
  audio.onerror=()=>{if(audio.src)toast('Không đọc được bản âm thanh. Thử nhập lại file.','error');};
  $('#waveformShell').onclick=event=>{const rect=event.currentTarget.getBoundingClientRect();seek((event.clientX-rect.left)/rect.width*state.project.duration);};
  $('#waveformShell').onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();seek(event.key==='Home'?0:event.key==='End'?state.project.duration:state.time+(event.key==='ArrowLeft'?-5:5));}};
  $('#audioVariant').onclick=()=>{if(!state.project.processed.noise)return;state.usingClean=!state.usingClean;setAudio(true);renderProject();};
  $('#noiseButton').onclick=()=>startJob('noise');$('#transcriptButton').onclick=()=>startJob('transcript');$('#speakerButton').onclick=()=>startJob('speakers');$('#processAllButton').onclick=()=>startJob('all');
  $('#cancelJobButton').onclick=async()=>{try{const job=processingJob(),item=state.batch.items.find(entry=>entry.job?.id===job?.id);if(item)await state.batch.cancel(item.id);else if(job)await api(`/api/jobs/${job.id}`,{method:'DELETE'});$('#cancelJobButton').disabled=true;setTimeout(()=>$('#cancelJobButton').disabled=false,2000);}catch(error){toast(error.message,'error');}};
  $$('.tab').forEach(tab=>tab.onclick=()=>switchTab(tab.dataset.tab));
  $('.tab-list').onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=$$('.tab');const index=tabs.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();switchTab(tabs[next].dataset.tab);};
  $('#searchTranscriptButton').onclick=()=>{$('#searchRow').hidden=!$('#searchRow').hidden;if(!$('#searchRow').hidden)$('#transcriptSearch').focus();};
  $('#transcriptSearch').oninput=event=>{state.query=event.target.value;renderTranscript();};$('#clearSearch').onclick=()=>{state.query='';$('#transcriptSearch').value='';renderTranscript();};
  $('#confidenceToggle').onchange=event=>{state.confidence=event.target.checked;renderTranscript();};
  $('#selectClipButton').onclick=startClipSelection;$('#clipCancelSelection').onclick=cancelClipSelection;
  $('#clipResetSelection').onclick=()=>{state.clipAnchor=null;state.clipEnd=null;renderTranscript();$('[data-clip-line]')?.focus({preventScroll:true});};
  $('#clipReviewButton').onclick=reviewClip;
  $('#addNoteButton').onclick=addNote;$('#noteInput').onkeydown=event=>{if(event.key==='Enter')addNote();};
  for(const id of ['viewAllNotesButton','openNotesTab'])$('#'+id).onclick=()=>{switchTab('notes');$('#transcriptCard').scrollIntoView({behavior:'smooth',block:'start'});};
  $('#addSpeakerButton').onclick=()=>openSpeaker();$('#saveSpeakerButton').onclick=saveSpeaker;$('#speakerNameInput').onkeydown=event=>{if(event.key==='Enter')saveSpeaker();};
  $('#editTranscriptButton').onclick=()=>{state.editing=!state.editing;$('#editTranscriptButton').innerHTML=state.editing?'Xong <span>✓</span>':'Chỉnh sửa transcript <span>→</span>';if(state.editing){state.query='';$('#transcriptSearch').value='';}renderTranscript();};
  for(const id of ['exportButton','exportQuickButton'])$('#'+id).onclick=openExport;
  $$('[data-export]').forEach(button=>button.onclick=()=>exportProject(button.dataset.export));
  $$('[data-report]').forEach(button=>button.onclick=()=>exportReport(button.dataset.report));
  $('#exportModal').addEventListener('close',()=>state.reportExporting?.controller.abort());
  $$('[data-close-modal]').forEach(button=>button.onclick=()=>$('#'+button.dataset.closeModal).close());
  $$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(dialog.id==='recordingModal'||dialog.id==='backupModal'&&backupDialog.task?.kind==='restore'||dialog.id==='subtitleModal'&&subtitleDialog.task?.kind==='import'||dialog.id==='historyModal'&&historyDialog.writing)return;if(event.target===dialog){const rectangle=dialog.getBoundingClientRect();if(event.clientX<rectangle.left||event.clientX>rectangle.right||event.clientY<rectangle.top||event.clientY>rectangle.bottom)dialog.close();}}));
  document.addEventListener('click',async event=>{
    const target=event.target;
    const clipLine=target.closest('[data-clip-line]');if(clipLine&&state.clipSelecting){if(!state.clipAnchor)state.clipAnchor=clipLine.dataset.clipLine;state.clipEnd=clipLine.dataset.clipLine;renderTranscript();$(`[data-clip-line="${CSS.escape(state.clipEnd)}"]`)?.focus({preventScroll:true});}
    if(target.closest('[data-review-clip]'))reviewClip();
    const seekButton=target.closest('[data-seek],[data-note-seek]');if(seekButton)seek(seekButton.dataset.seek||seekButton.dataset.noteSeek);
    const filter=target.closest('[data-speaker-filter]');if(filter){state.speaker=filter.dataset.speakerFilter;renderSpeakers();renderTranscript();}
    const speaker=target.closest('[data-edit-speaker]');if(speaker)openSpeaker(speaker.dataset.editSpeaker);
    if(target.closest('[data-start-transcript]'))startJob('transcript');
    if(target.closest('[data-generate-insights]'))generateInsights();
    const point=target.closest('[data-save-highlight]');if(point)saveHighlights(point.dataset.saveHighlight);
    const source=target.closest('[data-insight-source]');if(source)showInsightSource(source.dataset.insightSource);
    const remove=target.closest('[data-delete-note]');if(remove){const index=state.project.notes.findIndex(note=>note.id===remove.dataset.deleteNote);const [note]=state.project.notes.splice(index,1);renderNotes();save({notes:state.project.notes});toast('Đã xoá ghi chú.','info',()=>{state.project.notes.splice(index,0,note);renderNotes();save({notes:state.project.notes});});}
    const project=target.closest('[data-open-project]');if(project){try{await openProject(project.dataset.openProject);$('#libraryModal').close();}catch(error){toast(error.message,'error');}}
    const template=target.closest('[data-template]');if(template){state.notePrefix=template.dataset.template;$('#noteInput').placeholder=`${state.notePrefix}: …`;$('#templatesModal').close();$('#noteInput').focus();}
  });
  $('#transcriptList').addEventListener('input',event=>{const text=event.target.closest('[data-edit-line]');if(!text)return;const line=state.project.transcript.find(item=>item.id===text.dataset.editLine);if(line)line.text=text.textContent.slice(0,5000);});
  $('#transcriptList').addEventListener('focusout',event=>{if(event.target.matches('[data-edit-line]'))save({transcript:state.project.transcript});});
  $('#transcriptList').addEventListener('change',event=>{if(!event.target.matches('[data-line-speaker]'))return;const line=state.project.transcript.find(item=>item.id===event.target.dataset.lineSpeaker);if(line){line.speaker=event.target.value;save({transcript:state.project.transcript});renderSpeakers();}});
  $('#notesView').addEventListener('focusout',event=>{const field=event.target.closest('[data-edit-note]');if(!field)return;const note=state.project.notes.find(item=>item.id===field.dataset.editNote);if(!note)return;const text=field.textContent.trim().slice(0,2000);if(!text){field.textContent=note.text;return;}note.text=text;save({notes:state.project.notes});$('#quickNotesList').innerHTML=state.project.notes.slice(0,3).map(note=>noteMarkup(note)).join('');});
  $$('.nav-item').forEach(button=>button.onclick=()=>{if(button.dataset.nav==='settings')openSettings();else if(button.dataset.nav==='batch')openBatch();else if(button.dataset.nav==='backup')backupDialog.open();else if(button.dataset.nav==='templates')$('#templatesModal').showModal();else openLibrary(button.dataset.nav);});
  $('.help-button').onclick=()=>$('#helpModal').showModal();$('.topbar-bell').onclick=()=>{if(state.batch.running)openBatch();else toast(state.job?.status==='running'?state.job.message:'Các bản thu được xử lý trên máy. Không có tác vụ đang chạy.','info');};
  $('#fileOptionsButton').onclick=()=>{$('#projectNameInput').value=state.project.name;$('#downloadOriginal').href=`/api/projects/${state.project.id}/audio/download`;$('#downloadClean').hidden=!state.project.processed.noise;$('#downloadClean').href=`/api/projects/${state.project.id}/audio/clean?download=1`;$('#fileModal').showModal();};
  $('#renameProjectButton').onclick=()=>{const name=$('#projectNameInput').value.trim();if(!name)return;state.project.name=name;save({name});$('#fileName').textContent=name;$('#fileModal').close();};
  $('#saveSettingsButton').onclick=()=>{state.options={model:$('#settingModel').value,language:$('#settingLanguage').value,numSpeakers:Number($('#settingSpeakers').value),noiseStrength:$('#settingNoise').value};try{localStorage.setItem('audiokit-options',JSON.stringify(state.options));}catch{}$('#settingsModal').close();renderBatch();toast('Đã lưu cài đặt xử lý.');};
  $('#processingSettingsButton').onclick=openSettings;$('#demoTryButton').onclick=()=>startJob('all');
  let dragDepth=0;window.addEventListener('dragenter',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth++;$('#dropOverlay').hidden=false;}});window.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files'))event.preventDefault();});window.addEventListener('dragleave',event=>{event.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#dropOverlay').hidden=true;});window.addEventListener('drop',event=>{if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth=0;$('#dropOverlay').hidden=true;importFiles([...event.dataTransfer.files]);});
  window.addEventListener('resize',drawWaveform);new ResizeObserver(drawWaveform).observe($('#waveformShell'));
  document.addEventListener('keydown',event=>{if(event.target.closest('input,textarea,select,button,a,[contenteditable="true"],dialog'))return;if(event.code==='Space'){event.preventDefault();play();}if(event.key==='ArrowLeft')seek(state.time-(event.shiftKey?15:5));if(event.key==='ArrowRight')seek(state.time+(event.shiftKey?15:5));});
  window.addEventListener('beforeunload',event=>{if(state.saveCount||state.saveFailed||state.batch.hasUnuploaded||state.batch.exporting||backupDialog.busy||subtitleDialog.busy||historyDialog.writing){event.preventDefault();event.returnValue='';}});
}
function openSettings(){for(const[key,id]of [['model','settingModel'],['language','settingLanguage'],['numSpeakers','settingSpeakers'],['noiseStrength','settingNoise']])$('#'+id).value=state.options[key];$('#settingsModal').showModal();}
async function init(){
  bindEvents();
  try{
    const [health]=await Promise.all([api('/api/health'),refreshProjects(),state.batch.connect()]);
    let last;try{last=localStorage.getItem('audiokit-last');}catch{}
    const params=new URLSearchParams(location.search),linked=params.get('project');
    const found=linked==='demo'||state.projects.some(project=>project.id===linked);
    await openProject(found?linked:state.projects.some(project=>project.id===last)?last:'demo',true,found?Number(params.get('t')):0);
    if(linked&&!found)toast('Không tìm thấy bản thu được liên kết trên máy này.','info');
    if(health.activeJob&&!health.activeJob.queueItemId){state.job=health.activeJob;renderJob();pollJob();}
    $('#connectionState').textContent=health.aiInstalled?'AI cục bộ đã sẵn sàng':'Cần cài thư viện AI';
  }catch(error){$('#connectionState').textContent='Chưa kết nối máy chủ';$('#fileName').textContent='Khởi động Audio Toolkit bằng npm start';toast(`Không thể kết nối: ${error.message}`,'error');}
}
init();
