@echo off
rem =====================================================================
rem  ONE-TIME admin step: clear EasyTierService failure-restart policy,
rem  so that turning "mesh off" in the DSH wifi plugin really stops it.
rem
rem  Just double-click this file. It asks for UAC itself (or you can
rem  right-click -> Run as administrator).
rem  It does NOT touch any EasyTier config file.
rem  Revert with easytier-restore.cmd
rem =====================================================================
title EasyTier - allow stopping the mesh service (one-time)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0easytier-guard.ps1" -Action Clear
