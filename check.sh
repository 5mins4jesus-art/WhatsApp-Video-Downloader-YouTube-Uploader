#!/bin/bash
while :;do
  node list_messages.mjs 120363421733063812@g.us 10 2>&1;
  sleep 30
done
