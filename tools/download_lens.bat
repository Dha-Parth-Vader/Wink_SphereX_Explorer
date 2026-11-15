@echo off
rem Prompt 3, part 1 for Lens (targets 76-100): image lists, then cutout download. Safe to run again; finished files are skipped.
cd /d "%~dp0.."
set IDS=rwaur,kapteynsstar,gaia73009792,gaia12759552,svir,rcas,w1541,w1738,drtau,w0458,rhya,gaia84811520,lp944,v1647ori,uori,gaia72576384,exlup,2m0036,gaia72813568,cd3715492,lacaille8760axmi,mira,gaia28596096,gaia96316416,ugps0722
set PY=py -3.12
%PY% --version >nul 2>&1 || set PY=py
if not exist pipeline\out\logs mkdir pipeline\out\logs

echo Installing requirements...
%PY% -m pip install -q -r pipeline\requirements.txt || goto :fail

echo Step 1: listing SPHEREx images for 25 targets...
%PY% -u pipeline\step1_inventory.py --only %IDS% --workers 6 || goto :fail

echo Step 2: downloading cutouts. Progress goes to pipeline\out\logs\download_lens.log
%PY% -u pipeline\step2_download.py --only %IDS% --source s3 --workers 16 --cap 20 --fov 0.25 > pipeline\out\logs\download_lens.log 2>&1 || goto :fail

echo Done. Downloads are in pipeline\cache\
pause
exit /b 0

:fail
echo Something failed. See the messages above or pipeline\out\logs\download_lens.log, then run this file again.
pause
exit /b 1
