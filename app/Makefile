.PHONY: generate build clean setup

generate:
	xcodegen generate

build: generate
	xcodebuild -project TmuxIde.xcodeproj -scheme TmuxIde -configuration Debug build

clean:
	rm -rf TmuxIde.xcodeproj build

setup:
	./scripts/setup.sh
	$(MAKE) generate
