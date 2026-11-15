#!/bin/sh
set -eu
exec /usr/bin/node /opt/counselor/current/server/maintenance.js backup
