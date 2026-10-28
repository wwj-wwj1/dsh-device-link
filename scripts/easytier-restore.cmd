@echo off
rem =====================================================================
rem  Restore the typical EasyTier service failure-restart policy:
rem  RESTART x3, delay 5000ms, RESET_PERIOD 86400s
rem
rem  Double-click this file (it asks for UAC itself).
rem =====================================================================
title EasyTier - restore failure-restart policy
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0easytier-guard.ps1" -Action Restore
