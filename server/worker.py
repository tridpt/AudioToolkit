"""Local inference. Only fixed public model files are downloaded; audio never leaves the machine."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tarfile
import urllib.request
import wave

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

COLORS = ['#7472e9', '#ec8068', '#dcb151', '#44b998', '#5d9bd7', '#cc79bd', '#699478', '#b78e65']
EMBEDDING_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx'
SEGMENTATION_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
MODEL_HASHES = {
    'wespeaker_en_voxceleb_resnet34.onnx': '5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94',
    'segmentation.tar.bz2': '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    'segmentation.onnx': '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
}


def check_model(target):
    expected = MODEL_HASHES.get(target.name)
    if expected and hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        raise ValueError(f'Mô hình {target.name} không toàn vẹn. Xoá file này trong data/models/speakers để tải lại.')


def emit(kind, **data):
    print(json.dumps({'type': kind, **data}, ensure_ascii=False), flush=True)


def progress(stage, message, value=None):
    emit('progress', stage=stage, message=message, progress=value)


def read_audio(filename):
    import numpy as np
    with wave.open(str(filename), 'rb') as wav:
        if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2:
            raise ValueError('Bản thu chưa được chuẩn hoá đúng.')
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768.0
    return data


def inspect_audio(payload):
    import numpy as np
    audio = read_audio(payload['file'])
    buckets = np.array_split(audio, min(480, len(audio)))
    peaks = [round(float(np.max(np.abs(chunk))), 5) for chunk in buckets]
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    return {'peaks': peaks, 'peakDb': round(20 * math.log10(max(peak, 1e-8)), 1),
            'rmsDb': round(20 * math.log10(max(rms, 1e-8)), 1)}


def download(url, target):
    if target.exists() and target.stat().st_size > 100000:
        check_model(target)
        return target
    temporary = target.with_suffix(target.suffix + '.partial')
    target.parent.mkdir(parents=True, exist_ok=True)
    progress('downloading', 'Lần đầu: đang tải mô hình giọng nói. Bản thu vẫn ở máy bạn.')
    request = urllib.request.Request(url, headers={'User-Agent': 'AudioToolkit/1.0'})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as out:
            total = int(response.headers.get('Content-Length', 0))
            size = 0
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
                size += len(chunk)
                progress('downloading', f'Đang tải mô hình giọng nói: {size // 1048576} MB', size / total if total else None)
        if temporary.stat().st_size < 100000:
            raise ValueError('File mô hình tải về không đầy đủ.')
        expected = MODEL_HASHES.get(target.name)
        if expected and hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            raise ValueError('Mô hình tải về không vượt qua kiểm tra SHA-256.')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def speaker_models(data_dir):
    model_dir = data_dir / 'models' / 'speakers'
    embedding = download(EMBEDDING_URL, model_dir / 'wespeaker_en_voxceleb_resnet34.onnx')
    segmentation = model_dir / 'segmentation.onnx'
    if not segmentation.exists():
        archive = download(SEGMENTATION_URL, model_dir / 'segmentation.tar.bz2')
        # Read just one known file; never extract archive paths onto the filesystem.
        with tarfile.open(archive, 'r:bz2') as tar:
            candidates = [member for member in tar.getmembers() if member.name.endswith('/model.onnx') and member.isfile()]
            if len(candidates) != 1:
                raise ValueError('Gói mô hình giọng nói không hợp lệ.')
            source = tar.extractfile(candidates[0])
            temporary = segmentation.with_suffix('.partial')
            with temporary.open('wb') as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
            temporary.replace(segmentation)
    check_model(segmentation)
    return embedding, segmentation


def speaker_at(start, end, turns):
    weights = {}
    for turn in turns:
        overlap = max(0, min(end, turn['end']) - max(start, turn['start']))
        if overlap:
            weights[turn['speaker']] = weights.get(turn['speaker'], 0) + overlap
    if weights:
        return max(weights, key=weights.get)
    if turns:
        middle = (start + end) / 2
        return min(turns, key=lambda turn: abs((turn['start'] + turn['end']) / 2 - middle))['speaker']
    return 's1'


def build_lines(words, turns, duration):
    lines = []
    group = []
    previous_speaker = None

    def flush():
        if not group:
            return
        text = ''.join(word['text'] for word in group).strip()
        if text:
            probabilities = [word['probability'] for word in group if word.get('probability') is not None]
            lines.append({'id': f'line-{len(lines) + 1}', 'time': round(group[0]['start'], 3),
                          'end': round(min(duration, max(group[-1]['end'], group[0]['start'] + .03)), 3),
                          'speaker': previous_speaker or 's1', 'text': text,
                          'confidence': round(100 * sum(probabilities) / len(probabilities)) if probabilities else None})
        group.clear()

    for word in words:
        start, end = max(0, word['start']), min(duration, word['end'])
        if end <= start or not word['text'].strip():
            continue
        speaker = speaker_at(start, end, turns)
        if group and (speaker != previous_speaker or start - group[-1]['end'] > .65 or end - group[0]['start'] > 12 or sum(len(w['text']) for w in group) > 210):
            flush()
        previous_speaker = speaker
        group.append({**word, 'start': start, 'end': end})
        if word['text'].rstrip().endswith(('.', '?', '!', '。', '？', '！')) and end - group[0]['start'] > 1.2:
            flush()
    flush()
    return lines


def speaker_records(ids, existing=None):
    existing = {speaker['id']: speaker for speaker in (existing or [])}
    return [existing.get(speaker_id, {'id': speaker_id, 'name': f'Người nói {index + 1}', 'color': COLORS[index % len(COLORS)]})
            for index, speaker_id in enumerate(ids)]


def transcribe(payload, data_dir):
    from faster_whisper import WhisperModel
    audio = read_audio(payload['file'])
    progress('loading', 'Đang chuẩn bị Whisper. Lần đầu cần tải model; âm thanh không được tải lên.')
    cache = os.environ.get('AUDIO_MODEL_CACHE', str(data_dir / 'models' / 'whisper'))
    device = os.environ.get('WHISPER_DEVICE', 'auto')
    compute_type = os.environ.get('WHISPER_COMPUTE_TYPE', 'int8')
    try:
        model = WhisperModel(payload.get('model', 'base'), device=device, compute_type=compute_type,
                             cpu_threads=max(1, min(6, (os.cpu_count() or 4) - 1)), download_root=cache)
    except Exception:
        model = WhisperModel(payload.get('model', 'base'), device='cpu', compute_type='int8',
                             cpu_threads=max(1, min(6, (os.cpu_count() or 4) - 1)), download_root=cache)
    segments, info = model.transcribe(
        audio, language=None if payload.get('language', 'auto') == 'auto' else payload['language'],
        beam_size=5, vad_filter=True, word_timestamps=True, condition_on_previous_text=False,
        vad_parameters={'min_silence_duration_ms': 300, 'speech_pad_ms': 200},
        hallucination_silence_threshold=1.5,
    )
    words = []
    for segment in segments:
        if segment.no_speech_prob > .85:
            continue
        for word in segment.words or []:
            words.append({'text': word.word, 'start': word.start, 'end': word.end, 'probability': word.probability})
        progress('transcript', f'Đã nghe đến {round(segment.end)} / {round(info.duration)} giây…', min(.99, segment.end / max(1, info.duration)))
    if not words:
        raise ValueError('Không nhận ra lời nói. Kiểm tra bản thu, chọn ngôn ngữ hoặc thử model small.')
    lines = build_lines(words, payload.get('turns', []), payload['duration'])
    ids = list(dict.fromkeys(line['speaker'] for line in lines))
    return {'words': words, 'transcript': lines, 'language': info.language, 'model': payload.get('model', 'base'),
            'transcriptEdited': False, 'speakers': speaker_records(ids, payload.get('speakers'))}


def diarize(payload, data_dir):
    import sherpa_onnx
    embedding, segmentation = speaker_models(data_dir)
    progress('speakers', 'Đang phân tích các lượt nói và đặc trưng giọng…', 0)
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation)), num_threads=2),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding), num_threads=2),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=payload.get('numSpeakers') or -1, threshold=.5),
        min_duration_on=.3, min_duration_off=.5,
    )
    if not config.validate():
        raise ValueError('Không thể nạp mô hình giọng nói. Thử tải lại model trong data/models/speakers.')
    engine = sherpa_onnx.OfflineSpeakerDiarization(config)
    audio = read_audio(payload['file'])

    def callback(processed, total):
        progress('speakers', 'Đang tách các lượt nói…', min(.99, processed / max(1,total)))
        return 0

    result = engine.process(audio, callback=callback).sort_by_start_time()
    # Rename clusters in order of first appearance; these are anonymous labels, not identities.
    labels = {}
    turns = []
    for turn in result:
        if turn.speaker not in labels:
            labels[turn.speaker] = f's{len(labels) + 1}'
        turns.append({'start': max(0, round(turn.start,3)), 'end': min(payload['duration'], round(turn.end,3)), 'speaker': labels[turn.speaker]})
    if not turns:
        raise ValueError('Không tìm thấy lượt nói đủ rõ để phân tách. Thử bản thu có tiếng nói ít nhiễu hơn.')
    transcript = payload.get('transcript', [])
    if payload.get('words') and not payload.get('transcriptEdited'):
        transcript = build_lines(payload['words'], turns, payload['duration'])
    else:
        # Preserve manual edits. Assign each edited line to its dominant overlapping turn.
        transcript = [{**line, 'speaker': speaker_at(line['time'], line['end'], turns)} for line in transcript]
    return {'turns': turns, 'transcript': transcript, 'speakers': speaker_records(list(labels.values()), payload.get('speakers')),
            'diarizationModel': 'pyannote-segmentation-3.0 + wespeaker-en-voxceleb-resnet34'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(Path(args.input).read_text(encoding='utf-8-sig'))
        directory = Path(args.data)
        if payload['mode'] == 'inspect':
            output = inspect_audio(payload)
        elif payload['mode'] == 'transcript':
            output = transcribe(payload, directory)
        elif payload['mode'] == 'speakers':
            output = diarize(payload, directory)
        else:
            raise ValueError('Tác vụ không hợp lệ.')
        emit('result', result=output)
    except ImportError as error:
        emit('error', message=f'Thiếu thư viện AI ({error.name}). Chạy npm run setup:ai rồi thử lại.')
        sys.exit(1)
    except Exception as error:
        emit('error', message=str(error))
        sys.exit(1)
