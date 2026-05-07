PLUGIN_NAME = ubhd-3d-recipes
BUILD_DIR = build
ZIP_NAME = $(PLUGIN_NAME).zip
PACKAGE_STAGE_DIR = $(BUILD_DIR)/.package/$(PLUGIN_NAME)
VIEWER_PLUGIN_DIR = ../fylr-plugin-ubhd-3d-viewer
VIEWER_DIST_DIR = $(VIEWER_PLUGIN_DIR)/lib/ubhd-3d-viewer/dist
SOURCE_VIEWER_DIST_DIR = src/server/recipe/viewer-dist

copy_preview_viewer_assets:
	@if [ ! -d "$(VIEWER_DIST_DIR)/assets" ]; then \
		echo "Missing viewer dist at $(VIEWER_DIST_DIR). Run 'make -C $(VIEWER_PLUGIN_DIR) build' first." >&2; \
		exit 1; \
	fi

sync_preview_viewer_assets: copy_preview_viewer_assets
	rm -rf $(SOURCE_VIEWER_DIST_DIR)
	mkdir -p $(SOURCE_VIEWER_DIST_DIR)
	cp -r $(VIEWER_DIST_DIR)/assets $(SOURCE_VIEWER_DIST_DIR)/
	if [ -d $(VIEWER_DIST_DIR)/draco ]; then cp -r $(VIEWER_DIST_DIR)/draco $(SOURCE_VIEWER_DIST_DIR)/; fi

all: build

build: clean deps sync_preview_viewer_assets
	mkdir -p $(BUILD_DIR)/$(PLUGIN_NAME)
	if [ -d src ]; then cp -r src $(BUILD_DIR)/$(PLUGIN_NAME)/; fi
	if [ -d l10n ]; then cp -r l10n $(BUILD_DIR)/$(PLUGIN_NAME)/; fi
	if [ -d fas_config ]; then cp -r fas_config $(BUILD_DIR)/$(PLUGIN_NAME)/; fi
	cp -r node_modules $(BUILD_DIR)/$(PLUGIN_NAME)/
	if [ -f package.json ]; then cp package.json $(BUILD_DIR)/$(PLUGIN_NAME)/; fi
	if [ -f package-lock.json ]; then cp package-lock.json $(BUILD_DIR)/$(PLUGIN_NAME)/; fi

deps:
	@if [ ! -f package.json ]; then \
		echo "Missing package.json for recipe dependencies."; \
		exit 1; \
	fi
	npm ci

zip: clean deps sync_preview_viewer_assets
	mkdir -p $(PACKAGE_STAGE_DIR)
	cp manifest.master.yml $(PACKAGE_STAGE_DIR)/manifest.yml
	if [ -d src ]; then cp -r src $(PACKAGE_STAGE_DIR)/; fi
	if [ -d l10n ]; then cp -r l10n $(PACKAGE_STAGE_DIR)/; fi
	if [ -d fas_config ]; then cp -r fas_config $(PACKAGE_STAGE_DIR)/; fi
	cp -r node_modules $(PACKAGE_STAGE_DIR)/
	if [ -f package.json ]; then cp package.json $(PACKAGE_STAGE_DIR)/; fi
	if [ -f package-lock.json ]; then cp package-lock.json $(PACKAGE_STAGE_DIR)/; fi
	cd $(BUILD_DIR)/.package && zip ../$(ZIP_NAME) -r $(PLUGIN_NAME)
	rm -rf $(BUILD_DIR)/.package

clean:
	rm -rf $(BUILD_DIR)
