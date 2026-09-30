#!/usr/bin/env python3
"""Check structural proxies for H3 manga storyboard Markdown output."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


FIELDS = [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
]

OUTLINE_FIELDS = [
    "内容",
    "战斗动作链",
    "高燃设计",
    "战斗可读性",
    "上传素材",
    "视觉参考分工",
    "音频素材",
    "说话者",
    "有效台词",
    "时长理由",
    "分段必要性",
    "独立边界",
]

RETENTION_MODES = {
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
}

AUDIO_RETENTION_MODES = {"reference"}

FIXED_TAIL = """[Prohibited items]

Text / subtitles / UI / watermarks / logos / corner badges / letters / numbers / symbols / glyphs / pseudo-text / text-like graphic shapes / comic speech bubbles / comic sound-effect marks / real-world UI

[Mandatory declaration]

Clean full-screen animation footage, not a comic page or UI. No background music; keep only ambient sound, human voices, and sound effects. Do not render any subtitles, text, letters, numbers, symbols, glyphs, pseudo-text, watermarks, logos, speech bubbles, or sound-effect marks. Spoken dialogue inside <d> is audio only and must never appear visually."""

VALID_LANGUAGE_TAG = re.compile(r"^\[[A-Za-z][A-Za-z -]*\]\s*\S")

SPLIT_JUSTIFICATION = re.compile(
    r"超时|超过\s*15\s*秒|时空跳转|时间跳转|地点跳转|场景跳转|独立生成|"
    r"overload|over\s+15\s+seconds|time\s+jump|location\s+change|scene\s+change|independent generation",
    re.I,
)

FORBIDDEN = {
    "DEPENDENT_OPENING": [
        r"(?i)continue\s+(?:directly\s+)?from\s+(?:the\s+)?(?:previous|prior|last)\s+(?:P|unit|clip|shot|frame|action)",
        r"(?i)resume\s+(?:the\s+)?(?:previous|prior|last)\s+(?:action|movement|pose)",
        r"(?i)match\s+(?:the\s+)?(?:previous|prior|last)\s+(?:final\s+)?(?:frame|pose|camera|composition|movement)",
        r"(?i)(?:begin|start|open)\s+(?:on|from|with)\s+(?:the\s+)?same\s+(?:frame|pose|movement|camera)",
        r"延续上(?:一|个)P|承接上(?:一|个)P|从上(?:一|个)P继续|继续上一段",
    ],
    "DUPLICATE_EVENT": [
        r"(?i)shared\s+action\s+overlap",
        r"共享.{0,8}(?:动作|镜头).{0,8}(?:秒|重叠)|动作重叠|重复桥接",
    ],
}

FORBIDDEN_REFERENCE_MODES = re.compile(
    r"(?i)\b(?:keyframe\s+completion|I2VA|FL2VA|L2VA)\b"
)

COLOR_OPENINGS = (
    "The target video is black-and-white.",
    "The target video is in full color.",
)

ART_STYLE_WORDING = re.compile(
    r"(?i)"
    r"\b(?:style|aesthetic|chibi|anime|cartoon(?:ish)?|photorealistic|semi[- ]realistic|"
    r"watercolou?r|oil[- ]paint(?:ed|ing)|painterly|graphic[- ]novel|ink[- ]wash|"
    r"sketch(?:ed|y)?|hand[- ]drawn|pixel[- ]art|stop[- ]motion|claymation|low[- ]poly|"
    r"cel[- ]shad(?:ed|ing)|flat[- ]color(?:ed|ing)?|line[- ]art|linework|2D|3D)\b|"
    r"\b(?:manga|comic|cinematic|realistic|illustrative|2D|3D)\s+"
    r"(?:art\s+|visual\s+|rendering\s+)?style\b|"
    r"\b(?:art|visual|rendering)\s+style\b|"
    r"\bin\s+the\s+style\s+of\b|"
    r"\bstyle\s+(?:consistent\s+with|matching|matched\s+to|based\s+on|from|follows)\b|"
    r"\b(?:match|follow|preserve|replicate)\s+(?:the\s+)?(?:art|visual|rendering)?\s*style\b"
)

DEPENDENT_ELLIPSIS = [
    r"(?:关于|至于).{0,12}(?:事|事情|问题|方面)(?:吧|呢)?[.…]{2,}$",
    r"我(?:好像)?听.{0,5}说(?:过)?[^。！？!?]{0,4}[.…]{2,}$",
    r"(?:我(?:好像)?(?:觉得|想说|认为)|原因是|问题是|因为|但是|可是|所以|如果|虽然|不过|另外|首先|然后|其实|比如|例如|也就是)[^。！？!?]{0,10}[.…]{2,}$",
]

PADDING_EXCEPTIONS = re.compile(
    r"复杂动作|中型动作|必要静默|必要停顿|揭示停顿|情绪落点|情绪停顿|慢速台词|犹豫|震惊|悲伤|亲密|沉思|"
    r"complex action|necessary silence|reveal hold|emotional pause|slow delivery",
    re.I,
)


@dataclass
class Finding:
    level: str
    code: str
    location: str
    message: str


def add(items: list[Finding], level: str, code: str, location: str, message: str) -> None:
    items.append(Finding(level, code, location, message))


def effective_chars(text: str) -> int:
    return sum(character.isalnum() for character in text)


def unit_sections(text: str) -> list[tuple[str, int, str]]:
    hits = list(re.finditer(r"(?m)^##\s+(P\d{2,})｜(\d{1,2})秒｜[^\n]+$", text))
    result = []
    for index, hit in enumerate(hits):
        stop = hits[index + 1].start() if index + 1 < len(hits) else len(text)
        result.append((hit.group(1), int(hit.group(2)), text[hit.end():stop]))
    return result


def outline_entries(text: str) -> dict[str, tuple[int, str]]:
    stop = text.find("\n## P")
    outline = text if stop < 0 else text[:stop]
    hits = list(re.finditer(r"(?m)^\d+\.\s+(P\d{2,})｜(\d{1,2})秒｜[^\n]+$", outline))
    result: dict[str, tuple[int, str]] = {}
    for index, hit in enumerate(hits):
        end = hits[index + 1].start() if index + 1 < len(hits) else len(outline)
        result[hit.group(1)] = (int(hit.group(2)), outline[hit.end():end])
    return result


def field_value(meta: str, label: str) -> str | None:
    hit = re.search(rf"(?m)^\s*-\s*{re.escape(label)}[：:]\s*(.+)$", meta)
    return hit.group(1).strip() if hit else None


def section_value(body: str, label: str, next_label: str) -> str:
    hit = re.search(
        rf"(?ms)^{re.escape(label)}:\s*\n(.*?)(?=^{re.escape(next_label)}:)", body
    )
    return hit.group(1) if hit else ""


def picture_map(value: str | None) -> list[tuple[int, str]]:
    if not value:
        return []
    matches = re.findall(r"Picture\s+(\d+)\s*=\s*([^；;\n]+)", value, re.I)
    return [(int(number), re.sub(r"\s+", " ", source.strip())) for number, source in matches]


def audio_map(value: str | None) -> list[tuple[int, str]]:
    if not value or re.fullmatch(r"(?:无|None|N/A)", value.strip(), re.I):
        return []
    matches = re.findall(r"Audio\s+(\d+)\s*=\s*([^；;\n]+)", value, re.I)
    return [(int(number), re.sub(r"\s+", " ", source.strip())) for number, source in matches]


def speaker_map(value: str | None) -> list[tuple[int, str]]:
    if not value:
        return []
    matches = re.findall(r"\bS(\d+)\s*=\s*([^；;\n]+)", value, re.I)
    return [(int(number), re.sub(r"\s+", " ", name.strip())) for number, name in matches]


def validate(text: str) -> list[Finding]:
    findings: list[Finding] = []
    units = unit_sections(text)
    outlines = outline_entries(text)
    outline_stop = text.find("\n## P")
    outline_text = text if outline_stop < 0 else text[:outline_stop]
    global_map_hit = re.search(r"(?m)^\s*-\s*全局素材映射[：:]\s*(.+)$", outline_text)
    global_pictures = picture_map(global_map_hit.group(1) if global_map_hit else None)
    global_visual_hit = re.search(r"(?m)^\s*-\s*全局视觉参考分工[：:]\s*(.+)$", outline_text)
    global_visual_value = global_visual_hit.group(1).strip() if global_visual_hit else None
    global_audio_hit = re.search(r"(?m)^\s*-\s*全局音频映射[：:]\s*(.+)$", outline_text)
    global_audio_value = global_audio_hit.group(1).strip() if global_audio_hit else None
    global_audios = audio_map(global_audio_value)
    global_voice_hit = re.search(r"(?m)^\s*-\s*全局声音锚点[：:]\s*(.+)$", outline_text)
    global_voice_value = global_voice_hit.group(1).strip() if global_voice_hit else None
    global_voices = dict(speaker_map(global_voice_value))
    global_speaker_by_id: dict[int, str] = {}
    global_speaker_by_name: dict[str, int] = {}
    global_audio_bindings: dict[int, int] = {}

    if not units:
        add(findings, "FAIL", "NO_UNITS", "document", "未找到形如 ## P01｜12秒｜... 的单元。")
        return findings
    if "# 分段大纲" not in text:
        add(findings, "FAIL", "NO_OUTLINE", "document", "缺少 # 分段大纲。")
    if not global_map_hit:
        add(findings, "FAIL", "NO_GLOBAL_PICTURE_MAP", "outline", "缺少“全局素材映射”。")
    elif not global_pictures:
        add(findings, "FAIL", "BAD_GLOBAL_PICTURE_MAP", "outline", "全局素材映射未使用 Picture N = 来源 格式。")
    else:
        global_numbers = [number for number, _ in global_pictures]
        if global_numbers != list(range(1, len(global_numbers) + 1)):
            add(findings, "FAIL", "GLOBAL_PICTURE_NUMBERING", "outline", f"全局 Picture 编号须从 1 连续排列：{global_numbers}。")
    if not global_visual_hit:
        add(findings, "FAIL", "NO_GLOBAL_VISUAL_ROLES", "outline", "缺少“全局视觉参考分工”。")
    else:
        visual_picture_ids = {int(item) for item in re.findall(r"\bPicture\s+(\d+)\b", global_visual_value or "", re.I)}
        expected_visual_ids = {number for number, _ in global_pictures}
        if visual_picture_ids != expected_visual_ids:
            add(
                findings,
                "FAIL",
                "VISUAL_ROLE_COVERAGE",
                "outline",
                f"全局视觉参考分工必须恰好覆盖全部 Picture；预期 {sorted(expected_visual_ids)}，实际 {sorted(visual_picture_ids)}。",
            )
    if not global_audio_hit:
        add(findings, "FAIL", "NO_GLOBAL_AUDIO_MAP", "outline", "缺少“全局音频映射”；无音频时也须写“无”。")
    elif not global_audios and not re.fullmatch(r"(?:无|None|N/A)", global_audio_value or "", re.I):
        add(findings, "FAIL", "BAD_GLOBAL_AUDIO_MAP", "outline", "全局音频映射须使用 Audio N = 来源 格式，或写“无”。")
    elif global_audios:
        global_audio_numbers = [number for number, _ in global_audios]
        if global_audio_numbers != list(range(1, len(global_audio_numbers) + 1)):
            add(findings, "FAIL", "GLOBAL_AUDIO_NUMBERING", "outline", f"全局 Audio 编号须从 1 连续排列：{global_audio_numbers}。")
        if len(global_audios) > 3:
            add(findings, "FAIL", "TOO_MANY_AUDIO_REFERENCES", "outline", "H3 Ref2VA 最多使用 3 个音频参考。")
    if not global_voice_hit:
        add(findings, "FAIL", "NO_GLOBAL_VOICE_ANCHORS", "outline", "缺少“全局声音锚点”；无发言时也须写“无”。")
    elif not global_voices and not re.fullmatch(r"(?:无|None|N/A)", global_voice_value or "", re.I):
        add(findings, "FAIL", "BAD_GLOBAL_VOICE_ANCHORS", "outline", "全局声音锚点须使用 Sx = 角色 | 声音描述/Audio N 格式，或写“无”。")
    if not re.search(r"P间关系[：:].*硬切.*(?:无重复|不重复)", text):
        add(findings, "FAIL", "NO_DIRECT_CUT_DECLARATION", "outline", "大纲须声明 P 间直接硬切且无重复素材。")

    report_heading = re.search(r"(?m)^# 分段检测\s*$", text)
    report = text[report_heading.end():] if report_heading else ""
    report_status_hit = re.search(r"(?m)^\s*检测[：:]\s*(PASS|WARN|FAIL)\b", report, re.I)
    declared_status = report_status_hit.group(1).upper() if report_status_hit else None
    if not report_heading:
        add(findings, "FAIL", "NO_VALIDATION_RESULT", "document", "缺少 # 分段检测。")
    elif not declared_status:
        add(findings, "FAIL", "NO_VALIDATION_STATUS", "report", "缺少“检测：PASS/WARN/FAIL”。")

    expected = [f"P{i:02d}" for i in range(1, len(units) + 1)]
    actual = [name for name, _, _ in units]
    if actual != expected:
        add(findings, "FAIL", "UNIT_NUMBERING", "document", f"P 编号不连续：{actual}。")

    for name, duration, body in units:
        if not 4 <= duration <= 15:
            add(findings, "FAIL", "DURATION_RANGE", name, f"{duration} 秒不在 4–15 秒内。")

        outline = outlines.get(name)
        if outline is None:
            add(findings, "FAIL", "MISSING_OUTLINE_ENTRY", name, "缺少对应大纲条目。")
            meta = ""
        else:
            outline_duration, meta = outline
            if outline_duration != duration:
                add(findings, "FAIL", "DURATION_MISMATCH", name, "大纲与单元标题时长不一致。")
        for label in OUTLINE_FIELDS:
            if field_value(meta, label) is None:
                add(findings, "FAIL", "MISSING_OUTLINE_FIELD", name, f"大纲缺少“{label}”。")

        local_pictures = picture_map(field_value(meta, "上传素材"))
        if not local_pictures:
            add(findings, "FAIL", "BAD_PICTURE_MAP", name, "上传素材未使用 Picture N = 来源 格式。")
        else:
            local_numbers = [number for number, _ in local_pictures]
            if local_numbers != list(range(1, len(local_numbers) + 1)):
                add(findings, "FAIL", "PICTURE_NUMBERING", name, f"Picture 编号须从 1 连续排列：{local_numbers}。")
            if global_pictures and local_pictures != global_pictures:
                add(findings, "FAIL", "PICTURE_MAP_MISMATCH", name, "本 P 的 Picture 来源或顺序与全局素材映射不一致。")

        local_visual_value = field_value(meta, "视觉参考分工")
        normalized_global_visual = re.sub(r"\s+", " ", global_visual_value or "").strip()
        normalized_local_visual = re.sub(r"\s+", " ", local_visual_value or "").strip()
        if global_visual_hit and normalized_local_visual != normalized_global_visual:
            add(findings, "FAIL", "VISUAL_ROLE_MISMATCH", name, "本 P 的视觉参考分工与全局分工不一致。")

        local_audio_value = field_value(meta, "音频素材")
        local_audios = audio_map(local_audio_value)
        local_audio_is_none = bool(local_audio_value and re.fullmatch(r"(?:无|None|N/A)", local_audio_value.strip(), re.I))
        if not local_audios and not local_audio_is_none:
            add(findings, "FAIL", "BAD_AUDIO_MAP", name, "音频素材须使用 Audio N = 来源 格式，或写“无”。")
        elif local_audios != global_audios:
            add(findings, "FAIL", "AUDIO_MAP_MISMATCH", name, "本 P 的 Audio 来源或顺序与全局音频映射不一致。")

        split_reason = field_value(meta, "分段必要性") or ""
        if name == "P01":
            if not re.search(r"首段|first", split_reason, re.I):
                add(findings, "WARN", "BAD_FIRST_SPLIT_REASON", name, "P01 的分段必要性应标明首段。")
        elif not SPLIT_JUSTIFICATION.search(split_reason):
            add(findings, "WARN", "UNNECESSARY_SPLIT", name, "未说明为何不能与上一 P 在 15 秒内自然合并。")

        speaker_value = field_value(meta, "说话者")
        local_speakers = speaker_map(speaker_value)
        body_speaker_ids = {int(item) for item in re.findall(r"\(S(\d+)\)", body, re.I)}
        no_speakers_declared = bool(speaker_value and re.fullmatch(r"(?:无|None|N/A)", speaker_value.strip(), re.I))
        if not local_speakers and not (no_speakers_declared and not body_speaker_ids):
            add(findings, "FAIL", "BAD_SPEAKER_MAP", name, "说话者须使用 Sx = 角色名 格式；无发言时写“无”。")
        mapped_speaker_ids = {speaker_id for speaker_id, _ in local_speakers}
        if global_voices and mapped_speaker_ids != set(global_voices):
            add(findings, "FAIL", "SPEAKER_MAP_INCOMPLETE", name, "每个 P 的说话者必须重复完整的全局 S 编号集合。")
        for speaker_id in sorted(body_speaker_ids - mapped_speaker_ids):
            add(findings, "FAIL", "UNMAPPED_SPEAKER", name, f"正文使用了未在本 P 大纲定义的 S{speaker_id}。")
        for speaker_id, character_name in local_speakers:
            canonical_name = character_name.casefold()
            if speaker_id in global_speaker_by_id and global_speaker_by_id[speaker_id] != canonical_name:
                add(findings, "FAIL", "SPEAKER_ID_REUSED", name, f"S{speaker_id} 在不同 P 中被分配给不同角色。")
            if canonical_name in global_speaker_by_name and global_speaker_by_name[canonical_name] != speaker_id:
                add(findings, "FAIL", "SPEAKER_RENUMBERED", name, f"{character_name} 在不同 P 中使用了不同 speaker 编号。")
            global_speaker_by_id[speaker_id] = canonical_name
            global_speaker_by_name[canonical_name] = speaker_id
        for speaker_id in sorted(mapped_speaker_ids - set(global_voices)):
            add(findings, "FAIL", "VOICE_ANCHOR_MISSING", name, f"全局声音锚点缺少 S{speaker_id}。")

        positions = []
        for field in FIELDS:
            hits = list(re.finditer(rf"(?m)^{field}:\s*$", body))
            if len(hits) != 1:
                add(findings, "FAIL", "FIELD_COUNT", name, f"{field}: 应出现一次，实际 {len(hits)} 次。")
                positions.append(-1)
            else:
                positions.append(hits[0].start())
        valid_positions = [item for item in positions if item >= 0]
        if valid_positions != sorted(valid_positions):
            add(findings, "FAIL", "FIELD_ORDER", name, "六个 H3 字段顺序不正确。")

        subject_definitions = section_value(body, "subject_definitions", "summary")
        retention_analysis = section_value(body, "retention_analysis", "detailed_description")
        expected_picture_ids = {number for number, _ in global_pictures}
        subject_picture_ids = {int(item) for item in re.findall(r"<Picture\s+(\d+)>", subject_definitions, re.I)}
        retention_picture_ids = {int(item) for item in re.findall(r"<Picture\s+(\d+)>", retention_analysis, re.I)}
        body_picture_ids = {int(item) for item in re.findall(r"<Picture\s+(\d+)>", body, re.I)}
        for picture_id in sorted(expected_picture_ids - subject_picture_ids):
            add(findings, "FAIL", "PICTURE_NOT_DEFINED", name, f"subject_definitions 缺少 <Picture {picture_id}>。")
        for picture_id in sorted(expected_picture_ids - retention_picture_ids):
            add(findings, "FAIL", "PICTURE_NOT_RETAINED", name, f"retention_analysis 缺少 <Picture {picture_id}>。")
        for picture_id in sorted(body_picture_ids - expected_picture_ids):
            add(findings, "FAIL", "UNMAPPED_PICTURE", name, f"正文引用了未映射的 <Picture {picture_id}>。")
        for picture_id in sorted(expected_picture_ids & retention_picture_ids):
            lines = [line for line in retention_analysis.splitlines() if re.search(rf"<Picture\s+{picture_id}>", line, re.I)]
            if not any(any(re.search(rf"\b{mode}\b", line) for mode in RETENTION_MODES) for line in lines):
                add(findings, "FAIL", "RETENTION_MODE", name, f"<Picture {picture_id}> 未使用允许的 retention 类型。")

        expected_audio_ids = {number for number, _ in global_audios}
        subject_audio_ids = {int(item) for item in re.findall(r"<Audio\s+(\d+)>", subject_definitions, re.I)}
        retention_audio_ids = {int(item) for item in re.findall(r"<Audio\s+(\d+)>", retention_analysis, re.I)}
        body_audio_ids = {int(item) for item in re.findall(r"<Audio\s+(\d+)>", body, re.I)}
        for audio_id in sorted(expected_audio_ids - subject_audio_ids):
            add(findings, "FAIL", "AUDIO_NOT_DEFINED", name, f"subject_definitions 缺少 <Audio {audio_id}>。")
        for audio_id in sorted(expected_audio_ids - retention_audio_ids):
            add(findings, "FAIL", "AUDIO_NOT_RETAINED", name, f"retention_analysis 缺少 <Audio {audio_id}>。")
        for audio_id in sorted(body_audio_ids - expected_audio_ids):
            add(findings, "FAIL", "UNMAPPED_AUDIO", name, f"正文引用了未映射的 <Audio {audio_id}>。")
        local_binding_by_audio: dict[int, int] = {}
        for audio_id in sorted(expected_audio_ids):
            definition_lines = [line for line in subject_definitions.splitlines() if re.search(rf"<Audio\s+{audio_id}>", line, re.I)]
            binding_ids = {
                int(speaker_id)
                for line in definition_lines
                for speaker_id in re.findall(r"\(S(\d+)\)", line, re.I)
            }
            if len(binding_ids) != 1:
                add(findings, "FAIL", "AUDIO_SPEAKER_BINDING", name, f"<Audio {audio_id}> 必须绑定唯一 speaker。")
            else:
                speaker_id = next(iter(binding_ids))
                local_binding_by_audio[audio_id] = speaker_id
                if speaker_id not in mapped_speaker_ids:
                    add(findings, "FAIL", "AUDIO_SPEAKER_UNMAPPED", name, f"<Audio {audio_id}> 绑定的 S{speaker_id} 未在本 P 说话者映射中定义。")
                if audio_id in global_audio_bindings and global_audio_bindings[audio_id] != speaker_id:
                    add(findings, "FAIL", "AUDIO_REBOUND", name, f"<Audio {audio_id}> 在不同 P 中绑定了不同 speaker。")
                global_audio_bindings[audio_id] = speaker_id
            retention_lines = [line for line in retention_analysis.splitlines() if re.search(rf"<Audio\s+{audio_id}>", line, re.I)]
            if not any(any(re.search(rf"\b{mode}\b", line) for mode in AUDIO_RETENTION_MODES) for line in retention_lines):
                add(findings, "FAIL", "AUDIO_RETENTION_MODE", name, f"<Audio {audio_id}> 必须使用 reference。")
        bound_speakers = list(local_binding_by_audio.values())
        if len(bound_speakers) != len(set(bound_speakers)):
            add(findings, "FAIL", "MULTIPLE_AUDIO_FOR_SPEAKER", name, "多个音色 Audio 被绑定到同一 speaker。")

        for speaker_id in sorted(mapped_speaker_ids & set(global_voices)):
            anchor = global_voices[speaker_id]
            anchor_value = anchor.split("|", 1)[1].strip() if "|" in anchor else anchor.strip()
            audio_anchor = re.fullmatch(r"Audio\s+(\d+)", anchor_value, re.I)
            if audio_anchor:
                expected_audio_id = int(audio_anchor.group(1))
                if local_binding_by_audio.get(expected_audio_id) != speaker_id:
                    add(findings, "FAIL", "VOICE_AUDIO_MISMATCH", name, f"S{speaker_id} 的全局声音锚点与 Audio 绑定不一致。")
            elif anchor_value and anchor_value not in subject_definitions:
                add(findings, "FAIL", "VOICE_DESCRIPTION_DRIFT", name, f"subject_definitions 未逐字复用 S{speaker_id} 的全局声音锚点。")

        if FORBIDDEN_REFERENCE_MODES.search(body):
            add(findings, "FAIL", "REFERENCE_MODE", name, "检测到 I2VA/首尾帧或 keyframe completion 模式。")

        summary = re.search(r"(?ms)^summary:\s*\n\s*(.+?)(?=^retention_analysis:)", body)
        if summary and not re.match(r"\[reference generation(?: \+ audio reference)?\]", summary.group(1).strip()):
            add(findings, "FAIL", "SUMMARY_MODE", name, "summary 必须以 [reference generation] 开头。")
        has_audio_mode = bool(summary and re.match(r"\[reference generation \+ audio reference\]", summary.group(1).strip()))
        has_audio_definition = bool(re.search(r"<Audio\s+\d+>", subject_definitions, re.I))
        if has_audio_mode and not has_audio_definition:
            add(findings, "FAIL", "AUDIO_REFERENCE_MISSING", name, "summary 声明 audio reference，但 subject_definitions 未定义 Audio。")
        if has_audio_definition and not has_audio_mode:
            add(findings, "FAIL", "AUDIO_MODE_MISSING", name, "定义了 Audio，但 summary 未声明 audio reference。")
        music = re.search(r"(?ms)^non_diegetic_music:\s*\n?\s*([^\n]+)", body)
        if not music or music.group(1).strip() != "N/A":
            add(findings, "FAIL", "MUSIC_NOT_NA", name, "non_diegetic_music 必须为 N/A。")

        detailed = re.search(r"(?ms)^detailed_description:\s*\n(.*?)(?=^overall_soundscape:)", body)
        scope = detailed.group(1) if detailed else body
        color_opening = scope.lstrip()
        if not any(color_opening.startswith(item) for item in COLOR_OPENINGS):
            add(
                findings,
                "FAIL",
                "COLOR_ONLY_OPENING",
                name,
                "detailed_description 第一行必须只以固定黑白或彩色声明开头。",
            )
        prompt_without_tail = body.replace(FIXED_TAIL, "")
        if ART_STYLE_WORDING.search(prompt_without_tail):
            add(
                findings,
                "FAIL",
                "ART_STYLE_WORDING",
                name,
                "六字段提示词中检测到画风、媒介或渲染风格词；只允许声明黑白或彩色，视觉呈现应由参考图控制。",
            )
        for code, patterns in FORBIDDEN.items():
            if any(re.search(pattern, scope) for pattern in patterns):
                add(findings, "FAIL", code, name, "检测到跨 P 依赖或重复素材表达。")
        if "画外音" in body:
            add(findings, "FAIL", "VOICEOVER_MARKER", name, "请使用英文 off-screen voiceover 写法。")

        shot_hits = list(
            re.finditer(
                r"(?m)^\[Shot\s+(\d+)\](?:[ \t]+At[ \t]+00:(\d{2})\.(\d{3}),)?",
                scope,
            )
        )
        shot_numbers = [int(hit.group(1)) for hit in shot_hits]
        if not shot_numbers:
            add(findings, "FAIL", "NO_SHOTS", name, "detailed_description 中没有 Shot。")
        elif shot_numbers != list(range(1, len(shot_numbers) + 1)):
            add(findings, "FAIL", "SHOT_NUMBERING", name, f"Shot 编号不连续：{shot_numbers}。")
        timestamps: list[float] = []
        for index, hit in enumerate(shot_hits):
            has_inline_stamp = hit.group(2) is not None and hit.group(3) is not None
            if index == 0 and has_inline_stamp:
                add(findings, "FAIL", "SHOT1_TIMESTAMP", name, "Shot 1 不应有时间戳。")
            if index > 0 and not has_inline_stamp:
                add(findings, "FAIL", "MISSING_INLINE_TIMESTAMP", f"{name}/Shot {index + 1}", "Shot 2 起必须在 [Shot N] 后同一行写时间戳。")
            if has_inline_stamp:
                value = int(hit.group(2)) + int(hit.group(3)) / 1000
                timestamps.append(value)
                if not 0 < value < duration:
                    add(findings, "FAIL", "TIMESTAMP_RANGE", f"{name}/Shot {index + 1}", f"时间戳 {value:.3f} 越界。")
        if timestamps != sorted(set(timestamps)):
            add(findings, "FAIL", "TIMESTAMP_ORDER", name, "时间戳必须严格递增。")

        dialogue_raw = [item.strip() for item in re.findall(r"(?s)<d>(.*?)</d>", body)]
        if any(not item for item in dialogue_raw):
            add(findings, "FAIL", "EMPTY_DIALOGUE", name, "<d> 不能为空。")
        for item in dialogue_raw:
            if item and not VALID_LANGUAGE_TAG.match(item):
                add(findings, "FAIL", "MISSING_LANGUAGE_TAG", name, f"对白缺少 [Language] 标签：{item}")
        dialogue = [re.sub(r"^\[[^\]]+\]\s*", "", item) for item in dialogue_raw]
        chars = sum(effective_chars(item) for item in dialogue)
        if dialogue:
            last = dialogue[-1]
            if re.search(r"[，,:：;；、]$", last):
                add(findings, "FAIL", "BLOCK_SPLIT", name, f"末句以未闭合标点结束：{last}")
            if any(re.search(pattern, last) for pattern in DEPENDENT_ELLIPSIS):
                add(findings, "WARN", "DEPENDENT_UTTERANCE", name, f"末句疑似引导语而非完整意思：{last}")

        tail_count = body.count(FIXED_TAIL)
        if tail_count != 1:
            add(findings, "FAIL", "FIXED_TAIL", name, f"固定英文禁止项尾部应逐字出现一次，实际 {tail_count} 次。")

        declared_chars = field_value(meta, "有效台词")
        if declared_chars:
            number = re.match(r"(\d+)\s*字", declared_chars)
            if not number:
                add(findings, "FAIL", "BAD_DIALOGUE_COUNT", name, "有效台词须写成“N字”。")
            elif int(number.group(1)) != chars:
                add(findings, "FAIL", "DIALOGUE_COUNT_MISMATCH", name, f"大纲写 {number.group(1)} 字，实际 {chars} 字。")

        turns = max(0, len(dialogue) - 1) * 0.35
        speech_need = chars / 3.2 + turns
        visual_need = 2.5 + 1.6 * len(shot_hits) if shot_hits else 0
        estimated_need = max(speech_need, visual_need) + 0.75
        if estimated_need > duration + 0.5 or chars > duration * 4.0:
            add(findings, "WARN", "OVERLOAD", name, f"结构估算约需 {estimated_need:.1f} 秒，当前 {duration} 秒；请人工复核自然口播与动作。")
        reason = field_value(meta, "时长理由") or ""
        if duration - estimated_need > 2.2 and not PADDING_EXCEPTIONS.search(reason):
            add(findings, "WARN", "DURATION_PADDING", name, f"结构估算约需 {estimated_need:.1f} 秒，当前 {duration} 秒且未说明必要节奏。")

        if declared_status == "PASS":
            line = re.search(rf"(?m)^\s*{name}[：:].*$", report)
            if not line:
                add(findings, "FAIL", "MISSING_COMPACT_LINE", "report", f"缺少 {name} 检测行。")
            else:
                value = line.group(0)
                checks = [rf"{chars}\s*字", rf"{duration}\s*秒", r"块完整PASS", r"独立PASS", r"时长PASS"]
                if not all(re.search(pattern, value, re.I) for pattern in checks):
                    add(findings, "FAIL", "BAD_COMPACT_LINE", "report", f"{name} 检测行内容不完整或与正文不符。")

    has_fail = any(item.level == "FAIL" for item in findings)
    has_warn = any(item.level == "WARN" for item in findings)
    if declared_status == "PASS" and (has_fail or has_warn):
        add(findings, "FAIL", "REPORT_UNDERSTATES_FINDINGS", "report", "报告写 PASS，但脚本发现 WARN/FAIL。")
    elif declared_status == "WARN" and has_fail:
        add(findings, "FAIL", "REPORT_UNDERSTATES_FINDINGS", "report", "报告写 WARN，但脚本发现 FAIL。")
    if declared_status in {"WARN", "FAIL"}:
        if not re.search(r"(?m)^\s*P\d{2,}\s*｜\s*[A-Z][A-Z0-9_]+[：:]", report):
            add(findings, "FAIL", "MISSING_AFFECTED_FINDING", "report", "WARN/FAIL 须列出 P、原因码和证据。")
        if not re.search(r"(?m)^\s*建议[：:]", report):
            add(findings, "FAIL", "MISSING_REPAIR_ADVICE", "report", "WARN/FAIL 须给出修改建议。")
    return findings


def status(findings: list[Finding]) -> str:
    if any(item.level == "FAIL" for item in findings):
        return "FAIL"
    if any(item.level == "WARN" for item in findings):
        return "WARN"
    return "PASS"


def fixture(duration: int = 10, line: str = "这是一句完整并且足够自然的测试对白内容") -> str:
    chars = effective_chars(line)
    return f"""# 分段大纲
- 总单元数：1
- 生成总时长：{duration}秒
- 阅读顺序：上→下
- 色彩模式：彩色
- P间关系：直接硬切，无重复素材
- 全局素材映射：Picture 1 = 测试图
- 全局视觉参考分工：Picture 1 = 人物与场景外观、分镜和构图依据
- 全局音频映射：无
- 全局声音锚点：S1 = Test Woman | female, young adult, medium-high pitch, clear voice

1. P01｜{duration}秒｜测试
   - 内容：完整测试对白和动作落点
   - 战斗动作链：起势 → 正面突进 → 格挡接触 → 双方分开并站稳
   - 高燃设计：静—动主节奏；格挡为主冲击点；透视夸张强调突进，命中停顿强调接触
   - 战斗可读性：首镜建立双方左右方位，突进保持左向右，格挡点居中，末镜显示双方分开
   - 上传素材：Picture 1 = 测试图
   - 视觉参考分工：Picture 1 = 人物与场景外观、分镜和构图依据
   - 音频素材：无
   - 说话者：S1 = Test Woman
   - 有效台词：{chars}字
   - 时长理由：正常口播与三个画面节拍并行，结尾完成动作
   - 分段必要性：首段
   - 独立边界：自行建立场景并完成台词和动作，可直接硬切
   - 后期文字：无

## P01｜{duration}秒｜测试｜彩色
subject_definitions:
<Picture 1> is the active storyboard reference. <Subject 1> is Test Woman, with a female, young adult, medium-high pitch, clear voice.
summary:
[reference generation] A compact test scene.
retention_analysis:
<Picture 1>: fully_preserved in Shot 1, Shot 2, and Shot 3.
detailed_description:
The target video is in full color. Character and environment appearance follow <Picture 1>; shot order and composition follow its storyboard content. No panel borders, speech bubbles, subtitles, watermarks, logos, or readable text appear.
[Shot 1] An independent room establishing shot. <Subject 1> (S1) says: <d>[Chinese] {line}</d>
[Shot 2] At 00:03.000, she reacts.
[Shot 3] At 00:07.000, the action completes.
overall_soundscape:
Room tone and movement.
non_diegetic_music:
N/A

{FIXED_TAIL}

# 分段检测
检测：PASS｜1P／{duration}秒
P01：{chars}字／{duration}秒｜块完整PASS｜独立PASS｜时长PASS
"""


def fixed_three_picture_fixture(unit_count: int = 5, mismatch_unit: int | None = None, renumber_unit: int | None = None) -> str:
    line = "好。"
    chars = effective_chars(line)
    canonical_map = "Picture 1 = 第一张；Picture 2 = 第二张；Picture 3 = 第三张"
    outline_entries: list[str] = []
    unit_entries: list[str] = []
    report_entries: list[str] = []
    for index in range(1, unit_count + 1):
        name = f"P{index:02d}"
        local_map = canonical_map
        if mismatch_unit == index:
            local_map = "Picture 1 = 第一张；Picture 2 = 第三张；Picture 3 = 第二张"
        speaker_id = 2 if renumber_unit == index else 1
        outline_entries.append(f"""{index}. {name}｜5秒｜测试{index}
   - 内容：短句与单个画面落点
   - 战斗动作链：起势 → 单次突进 → 格挡接触 → 双方停止
   - 高燃设计：静—动主节奏；格挡为主冲击点；速度线强调突进，短促镜头后坐强调接触
   - 战斗可读性：双方方位、左向右的运动方向、居中接触点与停止状态均清楚
   - 上传素材：{local_map}
   - 视觉参考分工：Picture 1 = 分镜和构图依据；Picture 2 = 人物外观依据；Picture 3 = 场景外观依据
   - 音频素材：无
   - 说话者：S{speaker_id} = Test Woman
   - 有效台词：{chars}字
   - 时长理由：短句口播与单个画面落点并行，5秒为最短可行整数时长
   - 分段必要性：{'首段' if index == 1 else '与上一 P 存在场景跳转，无法在同一短片中自然合并'}
   - 独立边界：自行建立场景并完成台词和动作，可直接硬切
   - 后期文字：无""")
        unit_entries.append(f"""## {name}｜5秒｜测试{index}｜彩色
subject_definitions:
<Picture 1> is the primary storyboard reference. <Picture 2> and <Picture 3> preserve identity and scene continuity. <Subject 1> is Test Woman, with a female, young adult, medium-high pitch, clear voice.
summary:
[reference generation] A compact independent scene.
retention_analysis:
<Picture 1>: fully_preserved in Shot 1.
<Picture 2>: weak_reference for identity continuity.
<Picture 3>: weak_reference for scene continuity.
detailed_description:
The target video is in full color. Character appearance follows <Picture 2>; environment appearance follows <Picture 3>; shot order and composition follow <Picture 1>. No panel borders, speech bubbles, subtitles, watermarks, logos, or readable text appear.
[Shot 1] An independent room is established. <Subject 1> (S{speaker_id}) says: <d>[Chinese] {line}</d> The beat visibly completes.
overall_soundscape:
Quiet room tone and natural speech.
non_diegetic_music:
N/A

{FIXED_TAIL}""")
        report_entries.append(f"{name}：{chars}字／5秒｜块完整PASS｜独立PASS｜时长PASS")
    return f"""# 分段大纲
- 总单元数：{unit_count}
- 生成总时长：{unit_count * 5}秒
- 阅读顺序：上→下
- 色彩模式：彩色
- P间关系：直接硬切，无重复素材
- 全局素材映射：{canonical_map}
- 全局视觉参考分工：Picture 1 = 分镜和构图依据；Picture 2 = 人物外观依据；Picture 3 = 场景外观依据
- 全局音频映射：无
- 全局声音锚点：S1 = Test Woman | female, young adult, medium-high pitch, clear voice

{chr(10).join(outline_entries)}

{chr(10).join(unit_entries)}

# 分段检测
检测：PASS｜{unit_count}P／{unit_count * 5}秒
{chr(10).join(report_entries)}
"""


def audio_fixture(two_audio_same_speaker: bool = False) -> str:
    doc = fixture(duration=8)
    audio_mapping = "Audio 1 = Test Woman voice"
    local_audio = audio_mapping
    definitions = "<Audio 1> is the voice-timbre reference for <Subject 1> (S1)."
    retention = "<Audio 1>: reference - its timbre guides S1 without copying source words."
    if two_audio_same_speaker:
        audio_mapping += "；Audio 2 = Wrong duplicate voice"
        local_audio = audio_mapping
        definitions += "\n<Audio 2> is another voice-timbre reference for <Subject 1> (S1)."
        retention += "\n<Audio 2>: reference - its timbre also guides S1."
    doc = doc.replace("- 全局音频映射：无", f"- 全局音频映射：{audio_mapping}")
    doc = doc.replace(
        "- 全局声音锚点：S1 = Test Woman | female, young adult, medium-high pitch, clear voice",
        "- 全局声音锚点：S1 = Test Woman | Audio 1",
    )
    doc = doc.replace("   - 音频素材：无", f"   - 音频素材：{local_audio}")
    doc = doc.replace(
        "<Picture 1> is the active storyboard reference. <Subject 1> is Test Woman, with a female, young adult, medium-high pitch, clear voice.",
        "<Picture 1> is the active storyboard reference. <Subject 1> is Test Woman.\n" + definitions,
    )
    doc = doc.replace("[reference generation]", "[reference generation + audio reference]")
    doc = doc.replace(
        "<Picture 1>: fully_preserved in Shot 1, Shot 2, and Shot 3.",
        "<Picture 1>: fully_preserved in Shot 1, Shot 2, and Shot 3.\n" + retention,
    )
    return doc


def self_test() -> int:
    good = validate(fixture())
    short = fixture(duration=5, line="好。")
    short = short.replace("正常口播与三个画面节拍并行，结尾完成动作", "短句口播与单个画面落点并行")
    short = short.replace("fully_preserved in Shot 1, Shot 2, and Shot 3", "fully_preserved in Shot 1")
    short = re.sub(r"\n\[Shot 2\].*?(?=\noverall_soundscape:)", "", short, flags=re.S)
    dependency = validate(fixture().replace("An independent room establishing shot.", "Continue from the previous unit action."))
    semantic = validate(fixture(line="关于这个事吧……"))
    padded = validate(short.replace("P01｜5秒", "P01｜10秒").replace("生成总时长：5秒", "生成总时长：10秒").replace("1P／5秒", "1P／10秒").replace("1字／5秒", "1字／10秒"))
    picture_mismatch = validate(fixture().replace("- 上传素材：Picture 1 = 测试图", "- 上传素材：Picture 1 = 另一张"))
    missing_picture = fixture().replace(
        "Picture 1 = 测试图", "Picture 1 = 测试图；Picture 2 = 第二张"
    )
    missing_picture_findings = validate(missing_picture)
    wrong_reference_mode = validate(
        fixture().replace("An independent room establishing shot.", "Use keyframe completion. An independent room establishing shot.")
    )
    audio_without_definition = validate(
        fixture().replace("[reference generation]", "[reference generation + audio reference]")
    )
    fixed_three_picture = validate(fixed_three_picture_fixture())
    changed_three_picture = validate(fixed_three_picture_fixture(mismatch_unit=3))
    renumbered_speaker = validate(fixed_three_picture_fixture(renumber_unit=3))
    missing_tail = validate(fixture().replace("\n" + FIXED_TAIL, ""))
    missing_language = validate(fixture().replace("[Chinese] ", ""))
    missing_visual_roles = validate(fixture().replace("- 全局视觉参考分工：Picture 1 = 人物与场景外观、分镜和构图依据\n", ""))
    missing_color_opening = validate(
        fixture().replace("The target video is in full color. ", "")
    )
    changed_visual_role = validate(
        fixture().replace(
            "   - 视觉参考分工：Picture 1 = 人物与场景外观、分镜和构图依据",
            "   - 视觉参考分工：Picture 1 = 错误换绑的其他职责",
        )
    )
    invented_style = validate(
        fixture().replace(
            "The target video is in full color. ",
            "The target video is in full color. Full-color chibi 2D anime style consistent with <Picture 1>. ",
        )
    )
    voice_drift = validate(
        fixture().replace(
            "<Subject 1> is Test Woman, with a female, young adult, medium-high pitch, clear voice.",
            "<Subject 1> is Test Woman, with a male, middle-aged, low-pitch rough voice.",
        )
    )
    valid_audio = validate(audio_fixture())
    duplicate_audio_binding = validate(audio_fixture(two_audio_same_speaker=True))
    missing_fight_direction = validate(
        fixture().replace(
            "   - 战斗动作链：起势 → 正面突进 → 格挡接触 → 双方分开并站稳\n",
            "",
        )
    )
    unicode_dialogue_counts = {
        "Japanese": effective_chars("ありがとうございます"),
        "Korean": effective_chars("감사합니다"),
        "Arabic": effective_chars("شكرا"),
    }
    checks = [
        (status(good) == "PASS", "valid fixture did not pass", good),
        (status(validate(short)) == "PASS", "valid five-second fixture did not pass", validate(short)),
        (any(item.code == "DEPENDENT_OPENING" for item in dependency), "cross-P dependency was missed", dependency),
        (any(item.code == "DEPENDENT_UTTERANCE" for item in semantic), "dependent utterance was missed", semantic),
        (any(item.code == "DURATION_PADDING" for item in padded), "duration padding was missed", padded),
        (any(item.code == "PICTURE_MAP_MISMATCH" for item in picture_mismatch), "picture mapping mismatch was missed", picture_mismatch),
        (any(item.code == "PICTURE_NOT_DEFINED" for item in missing_picture_findings), "missing picture definition was missed", missing_picture_findings),
        (any(item.code == "PICTURE_NOT_RETAINED" for item in missing_picture_findings), "missing picture retention was missed", missing_picture_findings),
        (any(item.code == "REFERENCE_MODE" for item in wrong_reference_mode), "forbidden reference mode was missed", wrong_reference_mode),
        (any(item.code == "AUDIO_REFERENCE_MISSING" for item in audio_without_definition), "missing audio definition was missed", audio_without_definition),
        (status(fixed_three_picture) == "PASS", "fixed three-picture five-unit fixture did not pass", fixed_three_picture),
        (any(item.code == "PICTURE_MAP_MISMATCH" for item in changed_three_picture), "cross-unit picture remapping was missed", changed_three_picture),
        (any(item.code == "SPEAKER_RENUMBERED" for item in renumbered_speaker), "cross-unit speaker renumbering was missed", renumbered_speaker),
        (any(item.code == "FIXED_TAIL" for item in missing_tail), "missing fixed tail was missed", missing_tail),
        (any(item.code == "MISSING_LANGUAGE_TAG" for item in missing_language), "missing dialogue language tag was missed", missing_language),
        (any(item.code == "NO_GLOBAL_VISUAL_ROLES" for item in missing_visual_roles), "missing global visual roles was missed", missing_visual_roles),
        (any(item.code == "COLOR_ONLY_OPENING" for item in missing_color_opening), "missing color-only opening was missed", missing_color_opening),
        (any(item.code == "VISUAL_ROLE_MISMATCH" for item in changed_visual_role), "per-unit visual-role drift was missed", changed_visual_role),
        (any(item.code == "ART_STYLE_WORDING" for item in invented_style), "invented art-style wording was missed", invented_style),
        (any(item.code == "VOICE_DESCRIPTION_DRIFT" for item in voice_drift), "voice-description drift was missed", voice_drift),
        (status(valid_audio) == "PASS", "valid audio-reference fixture did not pass", valid_audio),
        (any(item.code == "MULTIPLE_AUDIO_FOR_SPEAKER" for item in duplicate_audio_binding), "duplicate audio-to-speaker binding was missed", duplicate_audio_binding),
        (
            any(
                item.code == "MISSING_OUTLINE_FIELD" and "战斗动作链" in item.message
                for item in missing_fight_direction
            ),
            "missing combat-chain field was missed",
            missing_fight_direction,
        ),
        (
            all(count > 0 for count in unicode_dialogue_counts.values()),
            f"Unicode dialogue characters were missed: {unicode_dialogue_counts}",
            [],
        ),
    ]
    for passed, message, items in checks:
        if not passed:
            print(f"SELF-TEST FAIL: {message}")
            for item in items:
                print(asdict(item))
            return 1
    print("SELF-TEST PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", nargs="?", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if not args.file:
        parser.error("file is required unless --self-test is used")
    try:
        text = args.file.read_text(encoding="utf-8-sig")
    except OSError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    findings = validate(text)
    result = {"status": status(findings), "findings": [asdict(item) for item in findings]}
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"STATUS: {result['status']}")
        if not findings:
            print("No structural findings.")
        for item in findings:
            print(f"[{item.level}] {item.code} @ {item.location}: {item.message}")
    return 1 if result["status"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
