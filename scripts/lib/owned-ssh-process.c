/* Test-only macOS process birth witness. Never emits command lines or environment. */
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <unistd.h>

static int snapshot(pid_t pid, struct proc_bsdinfo *info) {
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
  if (size != sizeof(*info)) {
    /* A failed query is absence only with an independent ESRCH confirmation. */
    if (kill(pid, 0) == -1 && errno == ESRCH) return 0;
    return -1;
  }
  if (info->pbi_pid != (uint32_t)pid || info->pbi_uid != getuid() ||
      info->pbi_start_tvsec == 0 || info->pbi_start_tvusec >= 1000000) return -1;
  if (info->pbi_status == SZOMB) return 0;
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2 || getuid() == 0) return 64;
  char *end;
  errno = 0;
  long requested = strtol(argv[1], &end, 10);
  if (errno || *end || requested <= 0 || requested > INT32_MAX) return 64;
  struct proc_bsdinfo before = {0}, after = {0};
  int first = snapshot((pid_t)requested, &before);
  if (first < 0) return 65;
  if (!first) { puts("null"); return 0; }
  int second = snapshot((pid_t)requested, &after);
  if (second < 0) return 65;
  if (!second) { puts("null"); return 0; }
  if (before.pbi_pid != after.pbi_pid || before.pbi_uid != after.pbi_uid ||
      before.pbi_start_tvsec != after.pbi_start_tvsec ||
      before.pbi_start_tvusec != after.pbi_start_tvusec) return 66;
  printf("{\"pid\":%u,\"uid\":%u,\"seconds\":%llu,\"microseconds\":%llu}\n",
         after.pbi_pid, after.pbi_uid,
         (unsigned long long)after.pbi_start_tvsec,
         (unsigned long long)after.pbi_start_tvusec);
  return 0;
}
