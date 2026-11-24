#!/usr/bin/env python3
"""Publish only the reviewed CIAG contact-summary module; preserve the other tenants' runtime."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--candidate', required=True)
parser.add_argument('--expected-sha256', required=True)
parser.add_argument('--source-commit', required=True)
parser.add_argument('--deploy-dir', required=True)
args = parser.parse_args()
os.umask(0o077)
deploy = Path(args.deploy_dir).resolve()
app = Path('/home/inpulse/htdocs/inpulse.infotecrs.inf.br/whatsapp')
node = Path('/home/inpulse/.nvm/versions/node/v22.14.0/bin/node')
target = app / 'dist/integrations/ciag/service.js'
candidate = Path(args.candidate).resolve()
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
if sha(target) != args.expected_sha256:
    raise SystemExit('O módulo ativo mudou. Revise o delta antes de publicar.')
subprocess.run([str(node), '--check', str(candidate)], check=True, capture_output=True)
backup = deploy / 'private' / ('ui-summary-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(mode=0o700)
shutil.copy2(target, backup / 'service-before.js')
shutil.copy2(candidate, backup / 'service-after.js')
env = dict(os.environ, PATH=str(node.parent) + ':' + os.environ['PATH'])

def restart():
    result = subprocess.run(['pm2', 'restart', 'whatsapp', '--kill-timeout', '45000'], cwd=app, env=env, capture_output=True, text=True)
    with (backup / 'restart.log').open('a') as output:
        output.write(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('Reinício falhou; consulte o log privado.')

def get(path, key=None):
    request = urllib.request.Request('http://127.0.0.1:8005' + path, headers={'Authorization': 'Bearer ' + key} if key else {})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)

before = get('/health')
key = json.loads((deploy / 'private/ciag-service-key.json').read_text())['key']
try:
    temporary = target.with_suffix('.ciag-ui-new')
    shutil.copy2(candidate, temporary)
    temporary.chmod(target.stat().st_mode & 0o777)
    temporary.replace(target)
    restart()
    for _ in range(30):
        try:
            after = get('/health')
            status = get('/api/integrations/ciag/v1/status', key)
            contacts = get('/api/integrations/ciag/v1/contacts', key)
            if status.get('connected') and all('lastMessageAt' in contact for contact in contacts):
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise RuntimeError('O serviço não passou na verificação após publicar.')
    receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceCommit': args.source_commit,
               'before': args.expected_sha256, 'after': sha(target), 'module': str(target), 'backup': str(backup),
               'connectionVerified': True, 'contactSummaryVerified': True, 'otherModulesChanged': False, 'newMessagesSent': 0}
    (deploy / 'ui-summary-deployment-success.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Resumo CIAG publicado; conexão e histórico preservados. Nenhuma mensagem enviada.')
except Exception:
    shutil.copy2(backup / 'service-before.js', target)
    restart()
    raise SystemExit('Publicação revertida; consulte o backup privado.')
