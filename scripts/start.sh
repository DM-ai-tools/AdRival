#!/bin/sh
# Railway/Docker set HOSTNAME to the container id. Next.js standalone binds to
# process.env.HOSTNAME, so we must force 0.0.0.0 or health checks fail.
export HOSTNAME=0.0.0.0
exec node server.js
