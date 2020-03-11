package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	log "github.com/sirupsen/logrus"
)

const (
	blockSize = 4096
	separator = string(filepath.Separator)
)

// See zsyscall_linux_amd64.go/Getdents.
// len(buf)>0.
func getdents(fd int, buf []byte) (n int, err int) {
	var _p0 unsafe.Pointer
	_p0 = unsafe.Pointer(&buf[0])
	r0, _, errno := syscall.Syscall(syscall.SYS_GETDENTS64, uintptr(fd), uintptr(_p0), uintptr(len(buf)))
	n = int(r0)
	err = int(errno)
	return
}

func clen(n []byte) int {
	for i := 0; i < len(n); i++ {
		if n[i] == 0 {
			return i
		}
	}
	return len(n)
}

// NewScanner determines the path type and returns a corresponding
// implementation of the Scanner interface.
func NewScanner(path PathInfo) Scanner {
	switch path.Type {
	case TypeIrods:
		return IrodsCollectionScanner{}
	default:
		return FileSystemScanner{}
	}
}

// Scanner defines the interface for scanning files iteratively
// from a namespace `path`.
type Scanner interface {
	// ScanMakeDir gets a list of file-like objects iteratively under the given path, and
	// performs mkdir-like operations when the iteration visits a directory-like object.
	//
	// How the iteration is done depends on the implementation. How the mkdir-like operation is
	// performed is also based on the implementation of the `dirmaker`.
	//
	// For example, it can be that the Scanner is implemented to loop over a local filesystem using
	// the `filepath.Walk`, while the `dirmaker` is implemented to create a remote iRODS collection.
	ScanMakeDir(path string, buffer int, dirmaker DirMaker) chan string
}

// FileSystemScanner implements the `Scanner` interface for a POSIX-compliant filesystem.
type FileSystemScanner struct {
	dirmaker DirMaker
	base     string
}

// ScanMakeDir gets a list of files iteratively under a file system `path`, and performs directory
// creation based on the implementation of the `dirmaker`.
func (s FileSystemScanner) ScanMakeDir(path string, buffer int, dirmaker DirMaker) chan string {

	files := make(chan string, buffer)

	s.dirmaker = dirmaker
	s.base = path

	go func() {
		s.fastWalk(path, false, &files)
		defer close(files)
	}()

	return files
}

// fastWalk uses linux specific way (i.e. syscall.SYS_GETDENT64) to walk through
// files and directories under the given root recursively.  Files are pushed to
// a given channel of type string. The caller is responsible for
// initiating and closing the provided channel.
func (s FileSystemScanner) fastWalk(root string, followLink bool, files *chan string) {

	// if mode == nil {
	// 	// retrieve FileMode when it is not provided by the caller
	// 	fpm, err := GetFilePathMode(root)
	// 	if err != nil {
	// 		return
	// 	}
	// 	// respect the path returned so that symlink can be followed on the referent's path.
	// 	root = filepath.Clean(fpm.Path)
	// 	*chanP <- *fpm
	// } else {
	// 	*chanP <- FilePathMode{Path: root, Mode: *mode}
	// }

	dir, err := os.Open(root)
	if err != nil {
		log.Error(fmt.Sprintf("%s", err))
		return
	}
	defer dir.Close()

	// Opendir.
	// See dir_unix.go/readdirnames.
	buf := make([]byte, blockSize)
	nbuf := len(buf)
	for {
		var errno int
		nbuf, errno = getdents(int(dir.Fd()), buf)
		if errno != 0 || nbuf <= 0 {
			return
		}

		// See syscall_linux.go/ParseDirent.
		subbuf := buf[0:nbuf]
		for len(subbuf) > 0 {
			dirent := (*syscall.Dirent)(unsafe.Pointer(&subbuf[0]))
			subbuf = subbuf[dirent.Reclen:]
			bytes := (*[10000]byte)(unsafe.Pointer(&dirent.Name[0]))

			// Using Reclen we compute the first multiple of 8 above the length of
			// Dirent.Name. This value can be used to compute the length of long
			// Dirent.Name faster by checking the last 8 bytes only.
			minlen := uintptr(dirent.Reclen) - unsafe.Offsetof(dirent.Name)
			if minlen > 8 {
				minlen -= 8
			} else {
				minlen = 0
			}

			var name = string(bytes[0 : minlen+uintptr(clen(bytes[minlen:]))])
			if name == "." || name == ".." { // Useless names
				continue
			}

			vpath := filepath.Join(root, name)

			switch dirent.Type {
			case syscall.DT_UNKNOWN:
				log.Warnf("unknonw file type: %s", vpath)
			case syscall.DT_REG:
				*files <- vpath
			case syscall.DT_DIR:
				// construct the directory to be created with dirmaker.
				if err := s.dirmaker.Mkdir(strings.TrimPrefix(vpath, s.base)); err != nil {
					log.Errorf("Mkdir failure: %s", err.Error())
				}
				s.fastWalk(vpath, followLink, files)
			case syscall.DT_LNK:

				// TODO: walk through symlinks is not supported due to issue with
				//       eventual infinite walk loop of A -> B -> C -> A cannot be
				//       easily detected.
				// log.Warnf("skip symlink: %s\n", vpath)
				// continue

				if !followLink {
					log.Warnf("skip symlink: %s\n", vpath)
					continue
				}

				// follow the link; but only to its first level referent.
				referent, err := filepath.EvalSymlinks(vpath)
				if err != nil {
					log.Errorf("cannot resolve symlink: %s error: %s\n", vpath, err)
					continue
				}

				// avoid the situation that the symlink refers to its parent, which
				// can cause infinite filesystem walk loop.
				if referent == root {
					log.Warnf("skip path to avoid symlink loop: %s\n", vpath)
					continue
				}

				log.Warnf("symlink only followed to its first non-symlink referent: %s -> %s\n", vpath, referent)
				s.fastWalk(referent, false, files)

			default:
				log.Warnf("skip unhandled file: %s (type: %s)", vpath, string(dirent.Type))
				continue
			}
		}
	}
}

// IrodsCollectionScanner implements the `Scanner` interface for iRODS.
type IrodsCollectionScanner struct {
	dirmaker DirMaker
}

// ScanMakeDir gets a list of data objects iteratively under a iRODS collection `path`, and performs
// directory creation based on the implementation of `dirmaker`.
func (s IrodsCollectionScanner) ScanMakeDir(path string, buffer int, dirmaker DirMaker) chan string {

	files := make(chan string, buffer)

	s.dirmaker = dirmaker

	return files
}
