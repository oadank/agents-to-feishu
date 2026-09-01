#!/usr/bin/env bash
# 9 家健康检查（排除 hermes）：纯文本回复能力
OUT=/c/D/opt/agents-to-feishu/logs/health9-$(date +%H%M).txt
LJS="C:/Users/oadan/AppData/Roaming/npm/node_modules/@larksuite/cli/scripts/run.js"
NODE="C:/Users/oadan/.workbuddy/binaries/node/versions/22.22.2/node.exe"
declare -A OID=(
  [claude]="ou_406738ac0fe3c798603fe18a54216bda"
  [codex]="ou_90370090e13f91c0f70b124fd08e5d12"
  [dsh]="ou_92f917e7c68400546379591b91e49b5f"
  [gemini]="ou_3d666bf313f6412d94622380d4c39eb2"
  [mimo]="ou_50c0eb98529734e5d0f65d29705d69ee"
  [openakita]="ou_deb99befe2fc9e1e3554e5078b42d8b3"
  [opencode]="ou_5e9935ef9500223662a01f137acc2511"
  [openclaw]="ou_256578a0840e67ff4dd9fe37a5e52e9d"
  [reasonix]="ou_accc1f5827f5f4248fce951e648529e7"
)
echo "=== 9 家健康检查 $(date +%T) ===" > "$OUT"
for bot in claude codex dsh gemini mimo openakita opencode openclaw reasonix; do
  log="/c/D/opt/agents-to-feishu/logs/$bot-out.log"
  l0=$(wc -l < "$log" 2>/dev/null || echo 0)
  "$NODE" "$LJS" im +messages-send --user-id "${OID[$bot]}" --text "健康检查：回复 OK 两个字" --as user > /tmp/h.json 2>&1
  ok=$(grep -aoE '"ok"[: ]+(true|false)' /tmp/h.json | head -1)
  sleep 75
  fin=$(tail -n +$((l0+1)) "$log" 2>/dev/null | grep -ac "FINAL")
  err=$(tail -n +$((l0+1)) "$log" 2>/dev/null | grep -acE "卡死|失败|Invalid")
  echo "$bot: 发送=$ok FINAL=$fin 异常=$err" >> "$OUT"
  sleep 35
done
echo "=== 完成 $(date +%T) ===" >> "$OUT"
cat "$OUT"
