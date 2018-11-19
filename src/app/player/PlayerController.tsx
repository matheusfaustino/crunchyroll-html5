import crContainer from 'crunchyroll-lib/config';
import { Formats, getMedia, getMediaByUrl } from 'crunchyroll-lib/media';
import { IHttpClient } from 'crunchyroll-lib/models/http/IHttpClient';
import { IMedia } from 'crunchyroll-lib/models/IMedia';
import { Container } from 'inversify';
import { h, render } from 'preact';
import parse = require('url-parse');
import { IMediaOptions } from '../../../node_modules/crunchyroll-lib/models/IMediaResolver';
import container from '../../config/inversify.config';
import {
  getCollectionCarouselDetail,
  getMediaMetadataFromDOM
} from '../media/CollectionCarouselParser';
import { HlsQualityResolver } from '../media/HlsQualityResolver';
import { LegacyQualityResolver } from '../media/LegacyQualityResolver';
import { NextVideo } from '../media/nextvideo';
import { IVideoDetail, PlaybackState } from '../media/player/IPlayerApi';
import { NextVideoEvent } from '../media/player/NextVideoEvent';
import { PlaybackStateChangeEvent } from '../media/player/PlaybackStateChangeEvent';
import { IPlayerConfig, Player } from '../media/player/Player';
import { VolumeChangeEvent } from '../media/player/VolumeChangeEvent';
import { IMediaService } from '../models/IMediaService';
import {
  IQualityResolver,
  IQualityResolverSymbol
} from '../models/IQualityResolver';
import { LegacyPlayerService } from '../services/LegacyPlayerService';
import { VilosPlayerService } from '../services/VilosPlayerService';
import { IStorage, IStorageSymbol } from '../storage/IStorage';
import {
  getCollectionCarouselPage,
  ICollectionCarouselPage
} from './crunchyroll';
import { getAvailableQualities } from './StandardPlayer';
import { StaticActionController } from './StaticActionController';
import { VideoTracker } from './Tracking';

export interface IPlayerControllerOptions {
  quality?: keyof Formats;
  mediaFormat?: string;
  mediaQuality?: string;
  playbackRate?: number;

  startTime?: number;
  sizeEnabled?: boolean;
  autoPlay?: boolean;
  affiliateId?: string;
}

declare interface IVolumeData {
  volume: number;
  muted: boolean;
}

export class PlayerController {
  get large(): boolean {
    return this._element.id === 'showmedia_video_box_wide';
  }

  private _element: Element;
  private _url: string;
  private _mediaId: string;

  private _sizeEnabled: boolean = true;

  private _startTime?: number;
  private _autoPlay?: boolean;
  private _affiliateId?: string;
  private _quality?: keyof Formats;
  private _mediaFormat?: string;
  private _mediaQuality?: string;
  private _playbackRate?: number;

  private _player?: Player;
  private _playerActionController?: StaticActionController;
  private _changedMedia: boolean = false;

  private _tracking?: VideoTracker;

  private _cachedCarouselPage?: ICollectionCarouselPage;

  private _storage: IStorage;

  private _originalHTML: string;

  constructor(
    _c: Container,
    element: Element,
    url: string,
    originalHTML: string,
    mediaId: string,
    options?: IPlayerControllerOptions
  ) {
    this._storage = _c.get<IStorage>(IStorageSymbol);
    this._element = element;
    this._url = url;
    this._originalHTML = originalHTML;
    this._mediaId = mediaId;

    if (options) {
      this._startTime = options.startTime;
      this._sizeEnabled = !!options.sizeEnabled;
      this._autoPlay = options.autoPlay;
      this._affiliateId = options.affiliateId;
      this._quality = options.quality ? options.quality : undefined;
      this._playbackRate = options.playbackRate;

      this._mediaFormat = options.mediaFormat;
      this._mediaQuality = options.mediaQuality;
    }
  }

  /**
   * Returns whether sizing is enabled.
   */
  public isSizeEnabled(): boolean {
    return this._sizeEnabled;
  }

  public render(): void {
    const onSizeChange = (large: boolean) => this._onSizeChange(large);
    const onPlayerReady = (player: Player) => this._onPlayerReady(player);

    render(
      <Player
        ref={onPlayerReady}
        onSizeChange={onSizeChange}
        large={this.large}
        sizeEnabled={this.isSizeEnabled()}
        config={this._getDefaultConfig()}
      />,
      this._element
    );
  }

  private _getThumbnailByMediaId(mediaId: string): string | undefined {
    const img = document.querySelector(
      'a.link.block-link.block[href$="-' + mediaId + '"] img.mug'
    );
    if (!img) return undefined;

    const url = img.getAttribute('src');
    if (!url) return undefined;

    return url.replace(/_[a-zA-Z]+(\.[a-zA-Z]+)$/, '_full$1');
  }

  private _getDefaultConfig(): IPlayerConfig {
    const thumbnailUrl = this._getThumbnailByMediaId(this._mediaId);
    if (!thumbnailUrl) return {};

    return {
      thumbnailUrl
    };
  }

  private async _onVolumeChange(e: VolumeChangeEvent): Promise<void> {
    const volume = e.volume;
    const muted = e.muted;

    const data = {
      volume,
      muted
    } as IVolumeData;

    await this._storage.set<IVolumeData>('volume', data);
  }

  private _onFullscreenChange(): void {
    if (!this._player || this._player.getApi().isFullscreen()) return;

    // Don't do anything if the media hasn't changed
    if (!this._changedMedia) return;

    const api = this._player.getApi();

    // Redirect the page to the current media
    const url = parse(this._url, window.location.href, true);
    url.query.t = Math.floor(api.getCurrentTime()).toString();

    location.href = url.toString();
  }

  private async _loadMedia(media: IMediaService): Promise<void> {
    if (!this._player) return;
    if (this._tracking) {
      this._tracking.dispose();
      this._tracking = undefined;
    }

    const title = media.getTitle();

    const videoConfig = {
      title,
      url: media.getDefaultFile(),
      duration: media.getDuration(),
      subtitles: media.getSubtitles(),
      startTime:
        this._startTime === undefined ? media.getStartTime() : this._startTime,
      autoplay:
        this._autoPlay === undefined ? media.isAutoPlay() : this._autoPlay,
      thumbnailUrl: media.getThumbnailUrl(),
      quality: this._quality,
      playbackRate: this._playbackRate
    } as IPlayerConfig;

    // Change the file URL to https if current page is also https
    if (
      window.location.href.indexOf('https://') === 0 &&
      videoConfig.url &&
      videoConfig.url.indexOf('http://') === 0
    ) {
      videoConfig.url = videoConfig.url.replace('http://', 'https://');
    }

    const volumeData = await this._storage.get<IVolumeData>('volume');
    if (volumeData) {
      videoConfig.muted = volumeData.muted;
      videoConfig.volume = volumeData.volume;
    }

    // Register the next video if there's one
    const nextVideoUrl = media.getNextMediaUrl();
    if (nextVideoUrl) {
      let nextVideo = NextVideo.fromUrlUsingDocument(nextVideoUrl);
      if (!nextVideo) {
        try {
          const detail = getCollectionCarouselDetail(nextVideoUrl);
          const mediaMetadata = getMediaMetadataFromDOM();
          if (mediaMetadata) {
            if (
              !this._cachedCarouselPage ||
              !this._cachedCarouselPage.data ||
              !this._cachedCarouselPage.data[detail.mediaId]
            ) {
              this._cachedCarouselPage = await getCollectionCarouselPage(
                detail.mediaId,
                detail.groupId,
                mediaMetadata.collection_id,
                detail.index
              );
            }
            if (
              this._cachedCarouselPage.data &&
              this._cachedCarouselPage.data[detail.mediaId]
            ) {
              const doc = new DOMParser().parseFromString(
                '<html><head /><body>' +
                  this._cachedCarouselPage.data[detail.mediaId] +
                  '</body />',
                'text/html'
              );
              nextVideo = NextVideo.fromElement(doc.body);
            }
          }
        } catch (e) {
          // It failed to get the carousel details for the next video.
        }
      }
      if (nextVideo) {
        videoConfig.nextVideo = {
          title: nextVideo.episodeNumber + ': ' + nextVideo.episodeTitle,
          duration:
            typeof nextVideo.duration === 'number' ? nextVideo.duration : NaN,
          url: nextVideo.url,
          thumbnailUrl: nextVideo.thumbnailUrl
        };
      }
    }

    this._tracking = new VideoTracker(
      media.getTracking(),
      this._player.getApi(),
      this._affiliateId
    );

    if (videoConfig.autoplay) {
      this._player.loadVideoByConfig(videoConfig);
    } else {
      this._player.cueVideoByConfig(videoConfig);
    }

    this._player.getApi().dispatchEvent('rebuild-settings');
  }

  private async _onNextVideo(e: NextVideoEvent): Promise<void> {
    if (!this._player) return;

    if (!this._player.getApi().isFullscreen()) {
      window.location.href = e.detail.url;
      return;
    }

    await this._playNextVideo(e.detail);
  }

  private async _playNextVideo(detail: IVideoDetail): Promise<void> {
    if (!this._player) return;

    this._url = detail.url;
    this._changedMedia = true;
    this._autoPlay = true;
    this._startTime = undefined;

    if (this._tracking) {
      this._tracking.dispose();
      this._tracking = undefined;
    }

    this._player.loadVideoByConfig({
      thumbnailUrl: detail.thumbnailUrl
    });

    let media: IMedia;
    const options = {
      affiliateId: this._affiliateId,
      autoPlay: this._autoPlay
    } as IMediaOptions;

    if (this._mediaFormat && this._mediaQuality) {
      options.streamFormat = this._mediaFormat;
      options.streamQuality = this._mediaQuality;
    }

    const httpClient = crContainer.get<IHttpClient>('IHttpClient');

    const res = await httpClient.get(detail.url);
    const vilos = VilosPlayerService.fromHTML(res.body, res.body);
    if (vilos) {
      container
        .rebind<IQualityResolver>(IQualityResolverSymbol)
        .toConstantValue(new HlsQualityResolver());
      await this._loadMedia(new VilosPlayerService(this._player, vilos));
    } else {
      container
        .rebind<IQualityResolver>(IQualityResolverSymbol)
        .toConstantValue(
          new LegacyQualityResolver(
            getAvailableQualities(),
            this._quality,
            async (quality?: keyof Formats) => this._getLegacyMedia(quality)
          )
        );
      if (this._quality) {
        media = await getMediaByUrl(detail.url, this._quality, options);
      } else {
        media = await getMediaByUrl(detail.url, options);
      }
      this._mediaId = media.getId();
      this._url = detail.url;

      await this._loadMedia(new LegacyPlayerService(this._player, media));
    }
  }

  private async _loadSettings(player: Player): Promise<void> {
    const api = player.getApi();

    let autoPlay: boolean | undefined = await this._storage.get('autoplay');
    if (typeof autoPlay !== 'boolean') {
      autoPlay = true;
    }

    api.setAutoPlay(autoPlay);
  }

  /**
   * Initial loading of player and the media to play.
   * @param player the player reference
   */
  private async _onPlayerReady(player: Player): Promise<void> {
    this._player = player;
    if (!player.base) throw new Error('Player base is undefined');

    if (this._playerActionController) {
      this._playerActionController.dispose();
    }
    this._playerActionController = new StaticActionController(
      player.base,
      player.getActions()
    );
    this._playerActionController.enterDocument();

    const api = player.getApi();
    api.listen('fullscreenchange', () => this._onFullscreenChange());
    api.listen('nextvideo', (e: NextVideoEvent) => this._onNextVideo(e));
    api.listen('volumechange', (e: VolumeChangeEvent) =>
      this._onVolumeChange(e)
    );
    api.listen('playbackstatechange', (e: PlaybackStateChangeEvent) =>
      this._onPlaybackStateChange(e)
    );
    api.listen('autoplaychange', () => {
      this._storage.set('autoplay', api.isAutoPlay());
    });

    await this._loadSettings(player);

    const vilos = VilosPlayerService.fromHTML(
      document.body.innerHTML,
      this._originalHTML
    );
    if (vilos) {
      container
        .rebind<IQualityResolver>(IQualityResolverSymbol)
        .toConstantValue(new HlsQualityResolver());

      await this._loadMedia(new VilosPlayerService(player, vilos));
    } else {
      container
        .rebind<IQualityResolver>(IQualityResolverSymbol)
        .toConstantValue(
          new LegacyQualityResolver(
            getAvailableQualities(),
            this._quality,
            async (quality?: keyof Formats) => this._getLegacyMedia(quality)
          )
        );

      const media = await this._getLegacyMedia(this._quality);

      await this._loadMedia(new LegacyPlayerService(player, media));
    }
  }

  private async _getLegacyMedia(quality?: keyof Formats): Promise<IMedia> {
    const options = {
      affiliateId: this._affiliateId,
      autoPlay: this._autoPlay
    } as IMediaOptions;

    if (this._mediaFormat && this._mediaQuality) {
      options.streamFormat = this._mediaFormat;
      options.streamQuality = this._mediaQuality;
    }

    if (quality) {
      return await getMedia(this._mediaId, this._url, quality, options);
    } else {
      return await getMedia(this._mediaId, this._url, options);
    }
  }

  private async _onPlaybackStateChange(
    e: PlaybackStateChangeEvent
  ): Promise<void> {
    if (
      e.state !== PlaybackState.ENDED ||
      !this._player ||
      !this._player.getApi().isAutoPlay()
    )
      return;

    const detail = this._player.getApi().getNextVideoDetail();
    if (!detail) return;

    if (!this._player.getApi().isFullscreen()) {
      window.location.href = detail.url;
      return;
    }

    await this._playNextVideo(detail);
  }

  private async _onSizeChange(large: boolean): Promise<void> {
    if (!this._player) return;
    const showmedia = document.querySelector('#showmedia');
    const showmediaVideo = document.querySelector('#showmedia_video');
    const mainMedia = document.querySelector('#main_content');
    if (!showmedia || !showmediaVideo || !mainMedia) return;

    const api = this._player.getApi();
    const playing = api.getPreferredPlaybackState() === PlaybackState.PLAYING;
    if (large) {
      this._element.setAttribute('id', 'showmedia_video_box_wide');
      this._element.classList.remove('xsmall-margin-bottom');
      mainMedia.classList.remove('new_layout');
      showmedia.parentElement!.classList.add('new_layout');
      showmedia.parentElement!.classList.add('new_layout_wide');
      showmedia.parentNode!.insertBefore(showmediaVideo, showmedia);
    } else {
      this._element.setAttribute('id', 'showmedia_video_box');
      this._element.classList.add('xsmall-margin-bottom');
      showmedia.parentElement!.classList.remove('new_layout');
      showmedia.parentElement!.classList.remove('new_layout_wide');
      mainMedia.classList.add('new_layout');
      if (mainMedia.childNodes.length === 0) {
        mainMedia.appendChild(showmediaVideo);
      } else {
        mainMedia.insertBefore(showmediaVideo, mainMedia.childNodes[0]);
      }
    }

    // Give player focus again after it has been moved
    this._player.focus();

    if (playing) {
      api.playVideo(true);
    }

    await this._storage.set('large', large);
  }
}
