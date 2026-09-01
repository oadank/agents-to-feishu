#!/usr/bin/env bash
# 全员 ASR+TTS 复测矩阵 v2（10 家全测，结果同时写文件防丢）
OUT=/c/D/opt/agents-to-feishu/logs/voice-matrix-result.txt
LJS="C:/Users/oadan/AppData/Roaming/npm/node_modules/@larksuite/cli/scripts/run.js"
NODE="C:/Users/oadan/.workbuddy/binaries/node/versions/22.22.2/node.exe"
LOGS="/c/D/opt/agents-to-feishu/logs"
declare -A OID=(
  [claude]="ou_406738ac0fe3c798603fe18a54216bda"
  [codex]="ou_90370090e13f91c0f70b124fd08e5d12"
  [dsh]="ou_92f917e7c68400546379591b91e49b5f"
  [gemini]="ou_3d666bf313f6412d94622380d4c39eb2"
  [hermes]="ou_4039e3c0ec55cc507c50a0cc99f4d55a"
  [mimo]="ou_50c0eb98529734e5d0f65d29705d69ee"
  [openakita]="ou_deb99befe2fc9e1e3554e5078b42d8b3"
  [opencode]="ou_5e9935ef9500223662a01f137acc2511"
  [openclaw]="ou_256578a0840e67ff4dd9fe37a5e52e9d"
  [reasonix]="ou_accc1f5827f5f4248fce951e648529e7"
)
echo "START $(date +%T)" > "$OUT"
for bot in claude codex dsh gemini hermes mimo openakita opencode openclaw reasonix; do
  uid="${OID[$bot]}"
  log="$LOGS/$bot-out.log"
  # ASR 轮
  l1=$(wc -l < "$log" 2>/dev/null || echo 0)
  ( cd /c/Users/oadan/AppData/Local/Temp && "$NODE" "$LJS" im +messages-send --user-id "$uid" --audio "asr-test.opus" --as user > /tmp/s1.json 2>&1 )
  ok1=$(grep -aoE '"ok"[: ]+(true|false)' /tmp/s1.json | head -1)
  sleep 80
  asr=$(tail -n +$((l1+1)) "$log" 2>/dev/null | grep -ac "语音转写成功")
  fin1=$(tail -n +$((l1+1)) "$log" 2>/dev/null | grep -ac "FINAL")
  err1=$(tail -n +$((l1+1)) "$log" 2>/dev/null | grep -ac "API 报错")
  echo "$bot ASR: send=$ok1 转写=$asr FINAL=$fin1 报错=$err1" >> "$OUT"
  sleep 25
  # TTS 轮
  l2=$(wc -l < "$log" 2>/dev/null || echo 0)
  ( "$NODE" "$LJS" im +messages-send --user-id "$uid" --text "请用语音回答：天空为什么是蓝色的？一句话" --as user > /tmp/s2.json 2>&1 )
  ok2=$(grep -aoE '"ok"[: ]+(true|false)' /tmp/s2.json | head -1)
  sleep 85
  tts=$(tail -n +$((l2+1)) "$log" 2>/dev/null | grep -ac "语音回复已发送")
  fin2=$(tail -n +$((l2+1)) "$log" 2>/dev/null | grep -ac "FINAL")
  err2=$(tail -n +$((l2+1)) "$log" 2>/dev/null | grep -ac "API 报错")
  echo "$bot TTS: send=$ok2 语音回复=$tts FINAL=$fin2 报错=$err2" >> "$OUT"
  sleep 20
done
echo "DONE $(date +%T)" >> "$OUT"
echo ALL-FINISHED
