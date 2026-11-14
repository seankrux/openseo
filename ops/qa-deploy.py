#!/usr/bin/env python3
"""Tokyo overlay release: preserve the previous image and container for rollback."""
import argparse
import copy
import datetime as dt
import hashlib
import http.client
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path('/root/audits/openseo-qa-20261114')
COMPOSE = pathlib.Path('/home/ubuntu/apps/openseo')
CONTAINER = 'openseo-open-seo-1'
PREFIXES = ('VITE_', 'AUTH_MODE', 'BYPASS_EMAIL_VERIFICATION',
            'POSTHOG_PUBLIC_KEY', 'POSTHOG_HOST', 'TURNSTILE_SITE_KEY',
            'POSTHOG_SOURCEMAPS')


def run(args, **kwargs):
    return subprocess.check_output(args, **kwargs)


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=60):
        super().__init__('localhost', timeout=timeout)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def docker_api(method, path, body=None):
    connection = DockerConnection()
    data = None if body is None else json.dumps(body).encode()
    connection.request(method, '/v1.45' + path, body=data,
                       headers={'Content-Type': 'application/json'})
    response = connection.getresponse()
    payload = response.read()
    if response.status >= 400:
        # Never print Docker request bodies: container environment is private.
        raise RuntimeError(f'Docker {method} {path.split("?")[0]} returned HTTP {response.status}')
    connection.close()
    return json.loads(payload) if payload else None


def inspect(name=CONTAINER):
    return json.loads(run(['docker', 'inspect', name]))[0]


def save(name, record):
    target = ROOT / 'logs' / name
    target.write_text(json.dumps(record, indent=2) + '\n')


def build(repo, tag):
    live = inspect()
    previous = live['Config']['Image']
    commit = run(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    if run(['git', 'diff', '--name-only'], cwd=repo).strip():
        raise RuntimeError('Build worktree has uncommitted tracked edits')
    values = dict(entry.split('=', 1) for entry in live['Config']['Env'])
    selected = {key: value for key, value in values.items() if key.startswith(PREFIXES)}
    raw = ''.join(f'{key}={selected[key]}\n' for key in sorted(selected)).encode()
    fingerprint = hashlib.sha256(raw).hexdigest()
    old_fingerprint = run(['docker', 'exec', CONTAINER, 'cat', '/app/dist/.openseo-build-env'], text=True).strip()
    if fingerprint != old_fingerprint:
        raise RuntimeError('Live runtime and built client fingerprints differ')
    environment = {key: value for key, value in os.environ.items() if not key.startswith(PREFIXES)}
    environment.update(selected)
    print('BUILD', tag, commit, 'base=' + previous, flush=True)
    with (ROOT / 'logs/vite-build.log').open('w') as log:
        subprocess.run(['pnpm', 'exec', 'vite', 'build'], cwd=repo,
                       env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
    with (ROOT / 'logs/typecheck-final.log').open('w') as log:
        subprocess.run(['pnpm', 'exec', 'tsc', '--noEmit'], cwd=repo,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    (repo / 'dist/.openseo-build-env').write_text(fingerprint)
    stage = pathlib.Path('/downloads/projects/openseo/.tmp/qa-20261114') / ('image-' + commit[:12])
    stage.mkdir()
    for name in ['src', 'dist', 'scripts']:
        shutil.copytree(repo / name, stage / name)
    for name in ['package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json',
                 'vite-plugin-precompressed-assets.ts']:
        shutil.copy2(repo / name, stage / name)
    # COPY overlays add a new layer; all prior images, source and data are retained.
    (stage / 'Dockerfile').write_text(
        f'FROM {previous}\nLABEL io.citythrive.commit="{commit}"\n'
        'LABEL io.citythrive.remediation="qa-fixes-20261114"\n'
        'COPY src /app/src\nCOPY dist /app/dist\nCOPY scripts /app/scripts\n'
        'COPY package.json pnpm-lock.yaml vite.config.ts tsconfig.json vite-plugin-precompressed-assets.ts /app/\n')
    with (ROOT / 'logs/docker-build.log').open('w') as log:
        subprocess.run(['docker', 'build', '-t', tag, str(stage)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    image_id = json.loads(run(['docker', 'image', 'inspect', tag]))[0]['Id']
    record = {'status': 'built', 'commit': commit, 'image': tag, 'image_id': image_id,
              'previous_image': previous, 'previous_image_id': live['Image'],
              'fingerprint_match': True, 'stage': str(stage), 'repo': str(repo)}
    save('candidate-image.json', record)
    print('BUILT', tag, image_id, flush=True)


def set_pin(tag):
    env_file = COMPOSE / '.env'
    lines = env_file.read_text().splitlines(keepends=True)
    found = False
    for index, line in enumerate(lines):
        if line.startswith('OPEN_SEO_IMAGE='):
            lines[index] = 'OPEN_SEO_IMAGE=' + tag + '\n'
            found = True
    if not found:
        raise RuntimeError('OPEN_SEO_IMAGE pin is missing')
    env_file.write_text(''.join(lines))
    override = COMPOSE / 'compose.override.yaml'
    lines = override.read_text().splitlines(keepends=True)
    found = False
    for index, line in enumerate(lines):
        if line.lstrip().startswith('image:'):
            indent = line[:len(line) - len(line.lstrip())]
            lines[index] = indent + 'image: ' + tag + '\n'
            found = True
            break
    if not found:
        raise RuntimeError('Compose image pin is missing')
    override.write_text(''.join(lines))


def deploy(tag):
    candidate = json.loads((ROOT / 'logs/candidate-image.json').read_text())
    if candidate['image'] != tag:
        raise RuntimeError('Candidate receipt names a different image')
    live = inspect()
    if live['Image'] != candidate['previous_image_id']:
        raise RuntimeError('Production changed after build; reconcile before deployment')
    event_since = dt.datetime.now(dt.timezone.utc).isoformat()
    timestamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_name = 'openseo-rollback-' + timestamp.lower()
    private = ROOT / '.private'
    private.mkdir(mode=0o700, exist_ok=True)
    for name in ['.env', 'compose.override.yaml']:
        target = private / (name.lstrip('.') + '.pre-' + timestamp)
        shutil.copy2(COMPOSE / name, target)
        target.chmod(0o600)
    config = copy.deepcopy(live['Config'])
    config['Image'] = tag
    config['Env'] = [
        'OPEN_SEO_IMAGE=' + tag if item.startswith('OPEN_SEO_IMAGE=') else item
        for item in config['Env']
    ]
    config['Labels']['io.citythrive.commit'] = candidate['commit']
    config['Labels']['io.citythrive.remediation'] = 'qa-fixes-20261114'
    config['Labels'].pop('com.docker.compose.replace', None)
    config['Labels']['com.docker.compose.image'] = candidate['image_id']
    host = copy.deepcopy(live['HostConfig'])
    # These runtime allocations must be requested again for the new container.
    host.pop('ContainerIDFile', None)
    host.pop('AutoRemove', None)
    config['HostConfig'] = host
    record = {**candidate, 'status': 'switching', 'previous_container': backup_name,
              'deployed_at': dt.datetime.now(dt.timezone.utc).isoformat()}
    save('deployment.json', record)
    switched = False
    new_id = None
    try:
        set_pin(tag)
        config_hash = run(['docker', 'compose', 'config', '--hash', 'open-seo'], cwd=COMPOSE, text=True).strip().split()[-1]
        config['Labels']['com.docker.compose.config-hash'] = config_hash
        subprocess.run(['docker', 'stop', CONTAINER], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['docker', 'rename', CONTAINER, backup_name], check=True)
        switched = True
        created = docker_api('POST', '/containers/create?name=' + CONTAINER, config)
        new_id = created['Id']
        docker_api('POST', '/containers/' + new_id + '/start')
        print('STARTED', tag, 'rollback=' + backup_name, flush=True)
        # Docker health events, rather than timer sleeps, gate the switch.
        events = subprocess.Popen(
            ['docker', 'events', '--since', event_since, '--format', '{{json .}}',
             '--filter', 'container=' + new_id, '--filter', 'event=health_status',
             '--filter', 'event=die', '--filter', 'event=oom'],
            stdout=subprocess.PIPE, text=True,
        )
        ready = False
        try:
            for line in events.stdout:
                event = json.loads(line)
                action = event.get('Action', event.get('status', ''))
                print('HEALTH EVENT', action, flush=True)
                if action in {'die', 'oom'}:
                    raise RuntimeError('Candidate container exited during startup')
                if action.endswith('unhealthy'):
                    raise RuntimeError('Candidate container became unhealthy')
                if action.endswith('healthy'):
                    ready = True
                    break
        finally:
            events.terminate()
            events.wait()
        if not ready:
            raise RuntimeError('Docker health event stream ended before readiness')
        with urllib.request.urlopen('http://127.0.0.1:3001/api/health', timeout=25) as response:
            health = json.load(response)
            if response.status != 200 or health.get('status') != 'ok':
                raise RuntimeError('Candidate application health failed')
        current = inspect()
        startup = run(['docker', 'logs', '--tail', '120', CONTAINER], stderr=subprocess.STDOUT, text=True)
        if 'Reusing existing build' not in startup:
            raise RuntimeError('Candidate did not reuse its verified client build')
        if current['Image'] != candidate['image_id']:
            raise RuntimeError('Running image digest differs from verified candidate')
        record.update(status='healthy', current_container_id=new_id,
                      application_health=health, rollback_available=True)
        save('deployment.json', record)
        # Old failed marker is preserved separately before this becomes current.
        (pathlib.Path('/root/jobs') / 'openseo-deploy.status').write_text('ok\n')
        (pathlib.Path('/root/jobs') / 'openseo-deploy-current.json').write_text(json.dumps(record, indent=2) + '\n')
        print('DEPLOYED', tag, 'healthy; rollback container and image retained', flush=True)
    except Exception:
        if switched:
            if new_id:
                subprocess.run(['docker', 'stop', new_id], stdout=subprocess.DEVNULL, check=False)
                subprocess.run(['docker', 'rename', new_id, 'openseo-failed-qa-' + timestamp.lower()], check=False)
            subprocess.run(['docker', 'rename', backup_name, CONTAINER], check=True)
            subprocess.run(['docker', 'start', CONTAINER], check=True, stdout=subprocess.DEVNULL)
        set_pin(candidate['previous_image'])
        record.update(status='rolled_back', failed_candidate_container=new_id)
        save('deployment.json', record)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['build', 'deploy'])
    parser.add_argument('--repo', type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    if args.mode == 'build':
        build(args.repo.resolve(), args.tag)
    else:
        deploy(args.tag)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('RELEASE FAILED:', type(error).__name__, str(error), file=sys.stderr)
        sys.exit(1)
