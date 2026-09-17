#!/bin/sh
# 這台機器對外看起來是哪個 IP？站方就是用這個去重的。
# 在 Pi 上跑一次，跟其他已經在跑代理的機器比對——一樣就代表多跑也沒用。
echo "對外 IP：$(curl -s https://api.ipify.org)"
