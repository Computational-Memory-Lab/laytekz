#!/usr/bin/python3 -I
"""Confine the Laytekz compiler and every TeX run with Linux Landlock + seccomp.

Why: on the server the compiler has no container around it and runs as the same
Unix user as the app, the tunnel and everything else. TeX's own switches
(openin_any=p, openout_any=p, restricted shell escape) stop pdfTeX, but
LuaTeX's Lua `io.open` READS any path the user can read, /proc/<pid>/environ
of the app included. Landlock is an unprivileged kernel sandbox (no root, no
user namespaces) that closes that hole for the whole process tree.

Two layers, both irreversible once applied (children inherit them):

  service  -- <program> [args]   Layer 1, wraps the compiler service itself.
      read-only : /usr /etc /proc /sys /dev, TeX Live, Node, the compiler
                  code, ~/galley-server/bin (this tooling; holds no secrets)
      read-write: DATA_DIR, the compiler's own HOME, /dev/null
      network   : may bind its own TCP port, may not connect anywhere
      Everything else (META_DIR with aldine.db, secrets, env files, the
      tunnel credentials, ~/.ssh, backups) does not exist for it.

  tool <name> [args]             Layer 2, one TeX tool run (PATH shims for
      latexmk, pdflatex, synctex, latexindent call this). Narrows layer 1 to
      ONE project, the one the run's working directory belongs to
      (DATA_DIR/projects/<id>, worktrees/<id>/<branch>, ...): read-only on
      the project, read-write on its top-level subdirectories except .git
      (see project_rules), plus a private temp dir; read-only system, TeX
      Live and font/biber caches;
      no TCP at all; seccomp refuses socket(), io_uring, ptrace, bpf, keyrings
      and the x32 ABI. Resource limits cap address space and file size, and
      the run gets a lower CPU priority so it cannot starve other services.

  run -- <program> [args]        Layer 2 around any program (for tests).
  selftest                       Report the kernel's Landlock ABI.

Configuration comes from the environment (set by run-compiler.sh from
compiler.env). Fails closed: if Landlock is unavailable the program is not
started unless GALLEY_SANDBOX_REQUIRE=0.
"""
import ctypes
import glob
import os
import secrets
import sys

# ---- kernel interface (x86_64) ---------------------------------------------
SYS_landlock_create_ruleset = 444
SYS_landlock_add_rule = 445
SYS_landlock_restrict_self = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
LANDLOCK_RULE_NET_PORT = 2

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13      # ABI 2
FS_TRUNCATE = 1 << 14   # ABI 3
NET_BIND_TCP = 1 << 0   # ABI 4
NET_CONNECT_TCP = 1 << 1

PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.prctl.restype = ctypes.c_int


def L(v):
    """A variadic argument passed at full register width (pointers stay pointers)."""
    return v if isinstance(v, (ctypes._Pointer, ctypes._CFuncPtr)) or type(v).__name__ == "CArgObject" else ctypes.c_long(0 if v is None else v)


def sys_call(nr, *args):
    return libc.syscall(ctypes.c_long(nr), *[L(a) for a in args])


def prctl(option, *args):
    args = list(args) + [0] * (4 - len(args))
    return libc.prctl(ctypes.c_int(option), *[L(a) for a in args])


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class NetPortAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("port", ctypes.c_uint64)]


class SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8), ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]


def die(msg, code=126):
    sys.stderr.write(f"galley-sandbox: {msg}\n")
    sys.exit(code)


def landlock_abi():
    v = sys_call(SYS_landlock_create_ruleset, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    return v if v > 0 else 0


def fs_rights(abi):
    r = (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_READ_DIR | FS_REMOVE_DIR | FS_REMOVE_FILE
         | FS_MAKE_CHAR | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM)
    if abi >= 2:
        r |= FS_REFER
    if abi >= 3:
        r |= FS_TRUNCATE
    return r


class Ruleset:
    def __init__(self, abi, net):
        self.abi = abi
        self.handled_fs = fs_rights(abi)
        self.net = net and abi >= 4
        attr = RulesetAttr(self.handled_fs, (NET_BIND_TCP | NET_CONNECT_TCP) if self.net else 0)
        size = ctypes.sizeof(RulesetAttr) if self.net else 8
        fd = sys_call(SYS_landlock_create_ruleset, ctypes.byref(attr), size, 0)
        if fd < 0:
            die(f"landlock_create_ruleset failed: {os.strerror(ctypes.get_errno())}")
        self.fd = fd

    def allow_path(self, path, access):
        try:
            pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except FileNotFoundError:
            return False
        try:
            if not os.path.isdir(path):
                access &= FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE
            access &= self.handled_fs
            attr = PathBeneathAttr(access, pfd)
            if sys_call(SYS_landlock_add_rule, self.fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(attr), 0) < 0:
                die(f"landlock_add_rule({path}) failed: {os.strerror(ctypes.get_errno())}")
        finally:
            os.close(pfd)
        return True

    def allow_bind(self, port):
        if not self.net:
            return
        attr = NetPortAttr(NET_BIND_TCP, port)
        if sys_call(SYS_landlock_add_rule, self.fd, LANDLOCK_RULE_NET_PORT, ctypes.byref(attr), 0) < 0:
            die(f"landlock net rule for port {port} failed: {os.strerror(ctypes.get_errno())}")

    def enforce(self):
        if prctl(PR_SET_NO_NEW_PRIVS, 1) != 0:
            die("prctl(NO_NEW_PRIVS) failed")
        if sys_call(SYS_landlock_restrict_self, self.fd, 0) < 0:
            die(f"landlock_restrict_self failed: {os.strerror(ctypes.get_errno())}")
        os.close(self.fd)


RO = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
RW_NOSYM = RO | FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_DIR | FS_MAKE_REG | FS_REFER | FS_TRUNCATE
RW = RW_NOSYM | FS_MAKE_SYM
DEVNULL = FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE

SYSTEM_RO = ["/usr", "/etc", "/proc", "/sys", "/dev", "/var/cache/fontconfig"]


def env_paths(name):
    return [p for p in os.environ.get(name, "").split(":") if p]


def apply_seccomp():
    """Refuse socket creation and a few kernel interfaces no TeX run needs."""
    LD_W_ABS, JEQ, JGE, RET = 0x20, 0x15, 0x35, 0x06
    AUDIT_ARCH_X86_64 = 0xC000003E
    ALLOW, ERRNO_EPERM, KILL = 0x7FFF0000, 0x00050000 | 1, 0x80000000
    denied = [41,        # socket (no network, no unix sockets: no talking to PM2, tmux or anything else)
              101,       # ptrace
              248, 249, 250,  # add_key, request_key, keyctl
              298,       # perf_event_open
              321,       # bpf
              323,       # userfaultfd
              425, 426, 427]  # io_uring_setup/enter/register (io_uring can open sockets past seccomp)
    prog = [(LD_W_ABS, 0, 0, 4), (JEQ, 1, 0, AUDIT_ARCH_X86_64), (RET, 0, 0, KILL), (LD_W_ABS, 0, 0, 0)]
    n = len(denied)
    # after the x32 check and the denied list come: ALLOW, ERRNO
    prog.append((JGE, n + 1, 0, 0x40000000))
    for i, nr in enumerate(denied):
        prog.append((JEQ, n - i, 0, nr))
    prog.append((RET, 0, 0, ALLOW))
    prog.append((RET, 0, 0, ERRNO_EPERM))
    arr = (SockFilter * len(prog))(*[SockFilter(*ins) for ins in prog])
    fprog = SockFprog(len(prog), arr)
    if prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(fprog)) != 0:
        die(f"seccomp filter failed: {os.strerror(ctypes.get_errno())}")


def require_landlock():
    abi = landlock_abi()
    if abi < 1:
        if os.environ.get("GALLEY_SANDBOX_REQUIRE", "1") == "0":
            sys.stderr.write("galley-sandbox: WARNING Landlock unavailable, running UNCONFINED\n")
            return 0
        die("Landlock is not available on this kernel; refusing to run TeX unconfined "
            "(set GALLEY_SANDBOX_REQUIRE=0 to override, which exposes every file this user can read)")
    return abi


def real(p):
    try:
        return os.path.realpath(p)
    except OSError:
        return p


def service(argv):
    abi = require_landlock()
    if not argv:
        die("service: no program given", 2)
    if abi:
        rs = Ruleset(abi, net=True)
        # GALLEY_SANDBOX_RO_RUNTIME: added by run-compiler.sh at launch (the
        # code slot and Node install it starts from).
        for p in SYSTEM_RO + env_paths("GALLEY_SANDBOX_RO") + env_paths("GALLEY_SANDBOX_RO_RUNTIME"):
            rs.allow_path(real(p), RO)
        for p in env_paths("GALLEY_SANDBOX_RW"):
            os.makedirs(p, mode=0o700, exist_ok=True)
            rs.allow_path(real(p), RW)
        rs.allow_path("/dev/null", DEVNULL)
        port = os.environ.get("PORT")
        if port and port.isdigit():
            rs.allow_bind(int(port))
        rs.enforce()
    os.environ["GALLEY_SANDBOX_LAYER"] = "1"
    os.execvp(argv[0], argv)


def project_root(cwd):
    """The project directory a TeX run in `cwd` belongs to, or None."""
    data = real(os.environ.get("DATA_DIR", ""))
    if data and (cwd == data or cwd.startswith(data + os.sep)):
        parts = os.path.relpath(cwd, data).split(os.sep)
        depth = {"projects": 2, "worktrees": 3, "template-previews": 2}.get(parts[0])
        if depth and len(parts) >= depth:
            return os.path.join(data, *parts[:depth])
        return None
    tmp_root = real(os.environ.get("GALLEY_TMP_ROOT", ""))
    if tmp_root and cwd.startswith(tmp_root + os.sep):
        return cwd  # latexindent's private scratch directory
    return None


def project_rules(proj):
    """Landlock rules for one project directory.

    Code running inside a TeX run must be assumed able to do anything its
    sandbox allows (LuaTeX's load() accepts binary Lua chunks, and crafted
    bytecode is a known way to native code). The app server runs git in
    this directory, so .git (a directory, or a file in a branch worktree)
    must stay read-only: a written hook or core.fsmonitor would run outside
    every sandbox. Landlock grants rights on whole subtrees and cannot
    subtract one, so the project root itself is read-only and only its
    top-level subdirectories other than .git (.aldine-out among them) are
    writable. Nothing new can be created in the root, and links into or
    renames out of .git are refused (no REFER right on its side).
    """
    rules = [(proj, RO)]
    if not os.path.lexists(os.path.join(proj, ".git")):
        return [(proj, RW_NOSYM)]  # a scratch directory, not a repository
    for entry in os.scandir(proj):
        if entry.name != ".git" and entry.is_dir(follow_symlinks=False):
            rules.append((entry.path, RW_NOSYM))
    return rules


def tool(argv):
    if not argv:
        die("tool: no tool name given", 2)
    name, args = os.path.basename(argv[0]), argv[1:]
    texbin = os.environ.get("GALLEY_TEXBIN", "")
    target = os.path.join(texbin, name)
    if not texbin or not os.access(target, os.X_OK):
        die(f"tool {name}: not found in GALLEY_TEXBIN", 127)
    # Children (pdflatex under latexmk, biber, ...) inherit the sandbox; they
    # must not stack another layer, so the shim directory leaves PATH here.
    # The compiler drops its API token before starting anything; this holds
    # even for a compiler build that does not.
    os.environ.pop("COMPILER_TOKEN", None)
    shims = real(os.environ.get("GALLEY_SHIMS", ""))
    os.environ["PATH"] = ":".join(p for p in os.environ.get("PATH", "").split(":") if p and real(p) != shims)
    if name == "latexindent" and os.environ.get("GALLEY_LATEXINDENT_PERL5LIB"):
        os.environ["PERL5LIB"] = os.environ["GALLEY_LATEXINDENT_PERL5LIB"]
    if os.environ.get("GALLEY_SANDBOX_LAYER") == "2":
        os.execv(target, [target] + args)
    confine_run()
    os.execv(target, [target] + args)


def confine_run():
    """Apply layer 2 to this process for the working directory's project."""
    os.environ.pop("COMPILER_TOKEN", None)
    abi = require_landlock()
    cwd = real(os.getcwd())
    proj = project_root(cwd)
    tmp_root = os.environ.get("GALLEY_TMP_ROOT") or os.environ.get("TMPDIR") or ""
    run_tmp = None
    if tmp_root:
        run_tmp = os.path.join(tmp_root, f"run-{os.getpid()}-{secrets.token_hex(4)}")
        os.makedirs(run_tmp, mode=0o700)
        os.environ["TMPDIR"] = run_tmp
        # luaotfload refuses to start without a writable cache. It still reads
        # the warmed caches in TeX Live's texmf-var (TEXMFSYSVAR, read-only
        # here); fonts it has not seen are cached for this run only.
        os.environ["TEXMFVAR"] = os.path.join(run_tmp, "texmf-var")
        # luaotfload reads its font-name index only from the writable cache,
        # so point that at the warmed, read-only index (a symlink: reads go
        # through to the target, which this run cannot write).
        names = os.environ.get("GALLEY_LUAOTFLOAD_NAMES", "")
        if names and os.path.isdir(names):
            generic = os.path.join(run_tmp, "texmf-var", "luatex-cache", "generic")
            os.makedirs(generic, mode=0o700)
            os.symlink(names, os.path.join(generic, "names"))

    # Resource limits: address space and largest file a run may write.
    import resource
    gib = 1024 ** 3
    as_limit = int(float(os.environ.get("GALLEY_TOOL_MAX_AS_GIB", "8")) * gib)
    fsize = int(float(os.environ.get("GALLEY_TOOL_MAX_FILE_GIB", "1")) * gib)
    resource.setrlimit(resource.RLIMIT_AS, (as_limit, as_limit))
    resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        os.nice(int(os.environ.get("GALLEY_TOOL_NICE", "5")))
    except OSError:
        pass

    if abi:
        rs = Ruleset(abi, net=True)  # net handled, no port allowed: no TCP at all
        for p in SYSTEM_RO + env_paths("GALLEY_SANDBOX_TOOL_RO"):
            rs.allow_path(real(p), RO)
        if proj:
            for path, access in project_rules(proj):
                rs.allow_path(path, access)
        if run_tmp:
            rs.allow_path(run_tmp, RW)
        # biber's self-extractor locks its (read-only) cache through this
        # file on every start; write access to the lock alone, nothing else.
        par = os.environ.get("PAR_GLOBAL_TMPDIR")
        if par:
            for lock in glob.glob(os.path.join(real(par), "par-*", "cache-*", "inc.lock")):
                rs.allow_path(lock, FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE)
        rs.allow_path("/dev/null", DEVNULL)
        rs.enforce()
    apply_seccomp()
    os.environ["GALLEY_SANDBOX_LAYER"] = "2"


def main():
    if len(sys.argv) < 2:
        die(__doc__.strip().split("\n\n")[0], 2)
    mode, rest = sys.argv[1], sys.argv[2:]
    if mode == "service":
        if rest[:1] == ["--"]:
            rest = rest[1:]
        service(rest)
    elif mode == "tool":
        tool(rest)
    elif mode == "run":
        # Any program under exactly the layer-2 rules a TeX run gets (used by
        # verify-compiler.sh to test the sandbox with a non-TeX program).
        if rest[:1] == ["--"]:
            rest = rest[1:]
        if not rest:
            die("run: no program given", 2)
        confine_run()
        os.execvp(rest[0], rest)
    elif mode == "selftest":
        abi = landlock_abi()
        print(f"landlock_abi={abi} network_rules={'yes' if abi >= 4 else 'no'}")
        sys.exit(0 if abi >= 1 else 1)
    else:
        die(f"unknown mode {mode}", 2)


if __name__ == "__main__":
    main()
