#!/bin/sh
i=1
while [ "$i" -le 200 ]; do
  printf '\033[8;1HNR04_TICK_%03d\033[K' "$i"
  i=$((i + 1))
  sleep 0.05
done
printf '\033[9;1HNR04_BUSY_DONE\033[K\n'
